//! The desktop app: the server runs in this process, and a window shows it (spec/desktop.md).

mod backup;
mod bridge;
mod download;
mod files;
mod i18n;
mod menu;
mod plaud_refresh;

use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::process::ExitCode;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::files::{AppConfig, Secrets};

/// The first port tried. Keeping the same port keeps the window's browser storage (theme, last settings page).
const DEFAULT_PORT: u16 = 38400;

fn main() -> ExitCode {
    let data_dir = files::data_dir();
    // The language comes first: every message after this point uses it.
    let saved_locale = AppConfig::load(&data_dir)
        .ok()
        .and_then(|config| config.locale);
    i18n::init(saved_locale.as_deref());
    if let Err(text) = files::check_free_space(&data_dir) {
        files::log(&data_dir, &format!("not started: {text}"));
        files::fatal_dialog(&i18n::t("dialog.freeSpaceTitle"), &text);
        return ExitCode::from(1);
    }
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        eprintln!("cannot create the data folder {}: {e}", data_dir.display());
        return ExitCode::from(2);
    }
    // One copy per data folder, decided before anything is logged or written.
    let Some(_lock) = files::instance_lock(&data_dir) else {
        // macOS hands a relaunch from Finder or the Dock to the running copy itself, so a
        // second process only comes from a shell; it leaves quietly without touching anything.
        return ExitCode::SUCCESS;
    };
    files::log(&data_dir, "main process started");
    match run(data_dir.clone()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            files::log(&data_dir, &format!("could not start: {e}"));
            files::fatal_dialog(&i18n::t("dialog.startFailedTitle"), &e);
            ExitCode::FAILURE
        }
    }
}

fn run(data_dir: PathBuf) -> Result<(), String> {
    let mut config = AppConfig::load(&data_dir)?;
    let secrets = Secrets::load_or_create(&data_dir)?;
    let launch_code = oah::ids::token_hex(32);
    // The bundled ffmpeg and ffprobe sit next to the app binary.
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(PathBuf::from))
    {
        for (key, tool) in [("FFMPEG_PATH", "ffmpeg"), ("FFPROBE_PATH", "ffprobe")] {
            let path = dir.join(tool);
            if path.exists() {
                // SAFETY: no other thread exists yet.
                unsafe { std::env::set_var(key, path) };
            }
        }
    }
    for (key, value) in files::user_env(&data_dir) {
        // SAFETY: no other thread exists yet; the runtime and the window start below.
        unsafe { std::env::set_var(key, value) };
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let listener = runtime.block_on(bind(config.port.unwrap_or(DEFAULT_PORT)))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    if config.port != Some(port) {
        files::log(&data_dir, &format!("app port is now {port}"));
        config.port = Some(port);
    }

    let server = oah::Config::desktop(
        &data_dir,
        &secrets.encryption_key,
        port,
        &launch_code,
        config.bound_user_id.clone(),
    )
    .map_err(|e| e.to_string())?;
    // Before the database is opened (and migrated) by this version.
    runtime
        .block_on(backup::before_upgrade(
            &data_dir,
            &server.database_path,
            config.last_version.as_deref(),
        ))
        .map_err(|e| i18n::tf("error.databaseBackupFailed", &[("reason", &e.to_string())]))?;
    let pool = runtime
        .block_on(oah::db::open(&server.database_path))
        .map_err(|e| i18n::tf("error.databaseOpenFailed", &[("reason", &e.to_string())]))?;
    let state = oah::AppState::new(server, pool);
    runtime.block_on(async { oah::start_workers(&state) });
    let app = oah::app(state);
    runtime.spawn(async move {
        let served = axum_serve(listener, app).await;
        if let Err(e) = served {
            tracing::error!(error = %e, "server stopped");
        }
    });
    config.last_version = Some(env!("CARGO_PKG_VERSION").to_owned());
    config.save(&data_dir);

    let show_tray = config.show_tray.unwrap_or(true);
    let launch_at_login = config.launch_at_login.unwrap_or(false);
    let locale = i18n::current();
    let shared = bridge::Shared {
        data_dir: data_dir.clone(),
        port,
        launch_secret: launch_code.clone(),
        session: std::sync::Mutex::new(None),
        close_to_background: std::sync::atomic::AtomicBool::new(
            config.close_action.as_deref() != Some("quit"),
        ),
        config: std::sync::Mutex::new(config),
    };
    let start_url = format!("http://127.0.0.1:{port}/api/desktop/session?code={launch_code}");
    let log_dir = data_dir.clone();
    tauri::Builder::default()
        .manage(shared)
        .invoke_handler(handlers())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--background"])))
        .setup(move |app| {
            // The commands go to this launch's page only; the port is known only now.
            app.add_capability(app_capability(port))?;
            let url = tauri::Url::parse(&start_url)?;
            let silent = std::env::args().any(|a| a == "--background");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("OpenAudioHub")
                .inner_size(1280.0, 820.0)
                .min_inner_size(720.0, 480.0)
                .visible(!silent)
                .initialization_script(bridge::bridge_script(locale))
                .on_navigation(move |target| {
                    if is_app_page(target, port) {
                        // Files are saved through the bridge. An API address never becomes a page.
                        let path = target.path();
                        return !(path.starts_with("/api/") && path != "/api/desktop/session");
                    }
                    // Anything else never loads in this window. Web addresses open in the browser.
                    if matches!(target.scheme(), "http" | "https") {
                        let _ = bridge::open_default_browser(target);
                    }
                    false
                })
                .build()?;
            menu::install_tray(app, show_tray, launch_at_login, locale)?;
            plaud_refresh::spawn(
                app.handle().clone(),
                port,
                app.state::<bridge::Shared>().launch_secret.clone(),
            );
            files::log(&log_dir, &format!("window opened on port {port}"));
            #[cfg(debug_assertions)]
            if std::env::var_os("OAH_DESKTOP_SELFTEST").is_some()
                && let Some(window) = app.get_webview_window("main")
            {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    let _ = window.eval(
                        "Promise.resolve().then(() => window.__openaudiohubDesktop.getPreferences()).then(p => window.__TAURI_INTERNALS__.invoke('selftest_report', { value: JSON.stringify({ preferences: p, bridgeVersion: window.__openaudiohubDesktop.version, pickFolder: typeof window.__openaudiohubDesktop.pickFolder }) })).catch(e => window.__TAURI_INTERNALS__.invoke('selftest_report', { value: 'error ' + e }))",
                    );
                });
            }
            Ok(())
        })
        .on_window_event(move |window, event| {
            // Closing the main window keeps recordings syncing in the background unless the user chose quit.
            if let WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
                && window.state::<bridge::Shared>().close_to_background.load(std::sync::atomic::Ordering::SeqCst)
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .map_err(|e| e.to_string())?
        .run(|app, event| {
            // Clicking the Dock icon while the window is hidden brings it back.
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main(app);
            }
        });
    Ok(())
}

fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    #[cfg(debug_assertions)]
    return tauri::generate_handler![
        bridge::prefs_get,
        bridge::prefs_set,
        bridge::set_locale,
        bridge::open_plaud_browser,
        bridge::pick_folder,
        bridge::save_text_file,
        download::download_recordings,
        bridge::desktop_secret,
        bridge::selftest_report
    ];
    #[cfg(not(debug_assertions))]
    return tauri::generate_handler![
        bridge::prefs_get,
        bridge::prefs_set,
        bridge::set_locale,
        bridge::open_plaud_browser,
        bridge::pick_folder,
        bridge::save_text_file,
        download::download_recordings,
        bridge::desktop_secret
    ];
}

/// The window's commands, granted to this launch's origin only. `capabilities/default.json` holds
/// the permission list with no remote URL; here the list gets the one origin the server bound.
fn app_capability(port: u16) -> String {
    let mut capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/default.json"))
            .expect("capabilities/default.json is valid JSON");
    if let Some(map) = capability.as_object_mut() {
        map.remove("$schema");
        map.insert("identifier".into(), serde_json::json!("app-origin"));
        map.insert(
            "remote".into(),
            serde_json::json!({ "urls": [format!("http://127.0.0.1:{port}/*")] }),
        );
    }
    capability.to_string()
}

/// True for this launch's own page: plain http to the loopback address and the bound port.
fn is_app_page(url: &tauri::Url, port: u16) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port_or_known_default() == Some(port)
}

/// Tells the window's page that the tray menu changed the language. The page applies it
/// without writing the choice back, so the two never loop.
pub fn apply_locale(app: &tauri::AppHandle, locale: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let script = format!(
            "window.dispatchEvent(new CustomEvent('oah:locale', {{ detail: {} }}))",
            serde_json::to_string(locale).unwrap_or_else(|_| "\"en\"".to_owned())
        );
        let _ = window.eval(&script);
    }
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// The saved port, else the next free one, so a second program on 38400 does not stop the app.
async fn bind(preferred: u16) -> Result<tokio::net::TcpListener, String> {
    for port in [preferred]
        .into_iter()
        .chain(preferred.saturating_add(1)..preferred.saturating_add(20))
        .chain([0])
    {
        if let Ok(listener) =
            tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await
        {
            return Ok(listener);
        }
    }
    Err(i18n::t("error.noFreePort"))
}

async fn axum_serve(listener: tokio::net::TcpListener, app: axum::Router) -> std::io::Result<()> {
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_launch_origin_is_the_app_page() {
        let url = |s: &str| tauri::Url::parse(s).unwrap();
        assert!(is_app_page(&url("http://127.0.0.1:38400/dashboard"), 38400));
        assert!(!is_app_page(&url("http://127.0.0.1:38401/"), 38400));
        assert!(!is_app_page(&url("https://127.0.0.1:38400/"), 38400));
        assert!(!is_app_page(&url("http://localhost:38400/"), 38400));
        assert!(!is_app_page(&url("http://example.com/"), 38400));
        assert!(!is_app_page(&url("about:blank"), 38400));
    }

    #[test]
    fn the_app_capability_names_one_origin() {
        let text = app_capability(38401);
        assert!(text.contains("http://127.0.0.1:38401/*"));
        assert!(!text.contains(":*"));
        assert!(text.contains("allow-desktop-secret"));
        // The template has no remote key of its own; the origin is added here.
        assert!(!include_str!("../capabilities/default.json").contains("\"remote\""));
    }
}
