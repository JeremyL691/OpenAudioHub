//! What the app window can ask of the desktop app: preferences and Plaud sign-in.
//! The page reaches these commands through `window.__openaudiohubDesktop`, defined by
//! `BRIDGE_SCRIPT`. Only the app's own local origin gets IPC (capabilities/default.json).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;

use crate::files::{self, AppConfig};
use crate::menu;

/// Defines the bridge object the web app looks for. Version 3 adds native text-file saving;
/// version 4 adds `reconnect`, which signs the window in again after its session ended;
/// version 5 drops the in-app Plaud sign-in (`connectPlaud`);
/// version 6 adds native audio downloads (`downloadRecordings`);
/// version 7 adds the interface language: `initialLocale`, `setLocale`, and the event the shell
/// sends when the language is chosen in its own menu.
const BRIDGE_TEMPLATE: &str = r#"
(() => {
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args || {});
  window.__openaudiohubDesktop = {
    version: 7,
    initialLocale: __INITIAL_LOCALE__,
    setLocale: (locale) => invoke("set_locale", { locale }),
    onLocaleChange: (listener) => {
      const handler = (event) => listener(String(event.detail || ""));
      window.addEventListener("oah:locale", handler);
      return () => window.removeEventListener("oah:locale", handler);
    },
    getPreferences: () => invoke("prefs_get"),
    setPreferences: (updates) => invoke("prefs_set", { updates }),
    openPlaudBrowser: (code) => invoke("open_plaud_browser", { code }),
    pickFolder: () => invoke("pick_folder"),
    saveTextFile: (filename, content) => invoke("save_text_file", { filename, content }),
    downloadRecordings: (ids, format) => invoke("download_recordings", { ids, format }),
    reconnect: async () => {
      const secret = await invoke("desktop_secret");
      const res = await fetch("/api/desktop/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { authorization: "Bearer " + secret },
      });
      return res.ok;
    },
  };
})();
"#;

/// The bridge script with this launch's settling language filled in.
pub fn bridge_script(locale: &str) -> String {
    BRIDGE_TEMPLATE.replace("__INITIAL_LOCALE__", &format!("{locale:?}"))
}

pub struct Shared {
    pub data_dir: PathBuf,
    /// The port this launch's server bound.
    pub port: u16,
    /// This launch's secret for `POST /api/desktop/session` (spec/auth.md).
    pub launch_secret: String,
    /// The session cookie background calls reuse, until the server refuses it.
    pub session: Mutex<Option<String>>,
    pub config: Mutex<AppConfig>,
    pub close_to_background: AtomicBool,
}

/// Exchanges the launch secret for a desktop session cookie. Background calls to the local
/// server reuse this instead of the window's own session.
pub(crate) async fn session_cookie(
    client: &reqwest::Client,
    port: u16,
    launch_secret: &str,
) -> Result<String, String> {
    let response = client
        .post(format!("http://127.0.0.1:{port}/api/desktop/session"))
        .header("authorization", format!("Bearer {launch_secret}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("the app answered {}", response.status().as_u16()));
    }
    response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(cookie_pair)
        .ok_or_else(|| "the app did not set a session cookie".to_owned())
}

/// The `name=value` part of a Set-Cookie header, unless it is only an attribute.
pub(crate) fn cookie_pair(set_cookie: &str) -> Option<String> {
    const ATTRIBUTES: [&str; 8] = [
        "path", "expires", "max-age", "domain", "samesite", "httponly", "secure", "priority",
    ];
    let pair = set_cookie.split(';').next()?.trim();
    let (name, value) = pair.split_once('=')?;
    let name = name.trim();
    if name.is_empty()
        || value.is_empty()
        || ATTRIBUTES.contains(&name.to_ascii_lowercase().as_str())
    {
        return None;
    }
    Some(pair.to_owned())
}

fn prefs_json(app: &AppHandle, config: &AppConfig) -> Value {
    json!({
        "closeAction": config.close_action.as_deref().unwrap_or("background"),
        "showTray": config.show_tray.unwrap_or(true),
        "launchAtLogin": app.autolaunch().is_enabled().unwrap_or(false),
        "locale": crate::i18n::current(),
    })
}

/// The language chosen in the page. Saves it, rebuilds the tray labels, and leaves the page as is.
#[tauri::command]
pub fn set_locale(
    app: AppHandle,
    shared: State<'_, Shared>,
    locale: String,
) -> Result<String, String> {
    let chosen =
        crate::i18n::normalize(&locale).ok_or_else(|| "unknown interface language".to_owned())?;
    {
        let mut config = shared.config.lock().unwrap_or_else(|e| e.into_inner());
        config.locale = Some(chosen.to_owned());
        config.save(&shared.data_dir);
    }
    crate::i18n::set(chosen);
    if let Err(e) = menu::relabel_public(&app, chosen) {
        files::log(
            &shared.data_dir,
            &format!("could not rebuild the menu: {e}"),
        );
    }
    Ok(crate::i18n::current().to_owned())
}

/// The launch secret, for the page's own sign-in exchange. Only the app's local page has IPC.
#[tauri::command]
pub fn desktop_secret(shared: State<'_, Shared>) -> String {
    shared.launch_secret.clone()
}

#[tauri::command]
pub fn prefs_get(app: AppHandle, shared: State<'_, Shared>) -> Value {
    let config = shared.config.lock().unwrap_or_else(|e| e.into_inner());
    prefs_json(&app, &config)
}

#[tauri::command]
pub fn prefs_set(
    app: AppHandle,
    shared: State<'_, Shared>,
    updates: Value,
) -> Result<Value, String> {
    let mut config = shared.config.lock().unwrap_or_else(|e| e.into_inner());
    let close_action = updates.get("closeAction").and_then(Value::as_str);
    if let Some(action) = close_action
        && !matches!(action, "background" | "quit")
    {
        return Err("closeAction must be background or quit".into());
    }
    let launch_at_login = updates.get("launchAtLogin").and_then(Value::as_bool);
    let locale = updates
        .get("locale")
        .and_then(Value::as_str)
        .and_then(crate::i18n::normalize);
    // The one step that can fail goes first: if it fails, no other preference has changed yet.
    if let Some(on) = launch_at_login {
        let auto = app.autolaunch();
        let result = if on { auto.enable() } else { auto.disable() };
        result.map_err(|e| format!("could not change launch at login: {e}"))?;
    }
    if let Some(action) = close_action {
        config.close_action = Some(action.to_owned());
        shared
            .close_to_background
            .store(action == "background", Ordering::SeqCst);
    }
    if let Some(show) = updates.get("showTray").and_then(Value::as_bool) {
        config.show_tray = Some(show);
        if let Some(tray) = app.tray_by_id("tray") {
            let _ = tray.set_visible(show);
        }
    }
    if let Some(on) = launch_at_login {
        config.launch_at_login = Some(on);
        menu::set_login_checked(&app, on);
    }
    if let Some(chosen) = locale {
        config.locale = Some(chosen.to_owned());
    }
    config.save(&shared.data_dir);
    if let Some(chosen) = locale
        && chosen != crate::i18n::current()
    {
        // The page made the choice; the tray menu follows, without echoing the event back.
        crate::i18n::set(chosen);
        if let Err(e) = menu::relabel_public(&app, chosen) {
            files::log(
                &shared.data_dir,
                &format!("could not rebuild the menu: {e}"),
            );
        }
    }
    Ok(prefs_json(&app, &config))
}

/// Shows a folder picker and returns the chosen folder, or `None` when the user cancels.
/// Runs the dialog's callback into a channel, so the command does not block the main thread.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(crate::i18n::t("dialog.chooseFolderTitle"))
        .pick_folder(move |picked| {
            let _ = tx.send(picked);
        });
    match rx.await {
        Ok(None) => Ok(None),
        Ok(Some(picked)) => {
            let path = picked
                .into_path()
                .map_err(|_| crate::i18n::t("error.folderPickerFailed"))?;
            Ok(Some(path.to_string_lossy().into_owned()))
        }
        Err(_) => Err(crate::i18n::t("error.folderPickerFailed")),
    }
}

/// Opens the native save dialog and writes a browser-generated text export to the chosen path.
#[tauri::command]
pub async fn save_text_file(
    app: AppHandle,
    filename: String,
    content: String,
) -> Result<bool, String> {
    let filename = safe_download_name(&filename);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_file_name(filename);
    if let Ok(downloads) = app.path().download_dir() {
        dialog = dialog.set_directory(downloads);
    }
    dialog.save_file(move |picked| {
        let _ = tx.send(picked);
    });
    let Some(picked) = rx
        .await
        .map_err(|_| "Could not open the save dialog.".to_owned())?
    else {
        return Ok(false);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || files::write_atomic(&path, &content))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(true)
}

fn safe_download_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = last
        .chars()
        .filter(|c| !c.is_control())
        .filter(|c| *c != '/' && *c != '\\')
        .skip_while(|c| *c == '.')
        .take(200)
        .collect();
    if cleaned.is_empty() {
        "download".into()
    } else {
        cleaned
    }
}

const TOKEN_SCHEME: &str = "oah-token";
const PLAUD_HOSTS: [&str; 2] = ["web.plaud.ai", "web.plaud.cn"];

/// Reads Plaud's own session token and hands it over by navigating to `oah-token://`, which
/// Rust intercepts. The page never gets app commands. Runs as an initialization script on
/// every page load and is re-run from Rust on a timer, because a hidden window throttles the
/// page's own timers. The token lives in the `pld_ut` cookie; `pld_tokenstr` storage is
/// checked as well.
pub(crate) const PLAUD_SCRIPT: &str = r#"
(() => {
  if (!/^web\.plaud\.(ai|cn)$/.test(location.hostname)) return;
  const report = (v) => {
    if (v) location.href = "oah-token://token?v=" + encodeURIComponent(v);
  };
  try {
    const stored = localStorage.getItem("pld_tokenstr");
    if (stored) { report(stored); return; }
  } catch (e) {}
  try {
    const match = document.cookie.match(/(?:^|;\s*)pld_ut=([^;]+)/);
    if (match && match[1]) report(decodeURIComponent(match[1]));
  } catch (e) {}
})()
"#;

/// `"\"bearer eyJ...\""` (Plaud's stored form) → `eyJ...`, or `None` when it is not a JWT.
pub fn bare_token(stored: &str) -> Option<String> {
    let mut t = stored.trim().to_owned();
    if let Ok(Value::String(inner)) = serde_json::from_str::<Value>(&t) {
        t = inner;
    }
    let t = t.trim();
    let t = t
        .strip_prefix("bearer ")
        .or_else(|| t.strip_prefix("Bearer "))
        .unwrap_or(t)
        .trim();
    (t.split('.').count() == 3 && t.len() > 20).then(|| t.to_owned())
}

/// Decodes `%XX` escapes; `None` when the text has none or is malformed.
pub(crate) fn percent_decode(input: &str) -> Option<String> {
    if !input.contains('%') {
        return None;
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The JWT in a captured value, or `None` when it is not one or is too old. `current_expiry`
/// is the expiry of the token in use; a refresh only accepts something newer (spec 11.1, 11.2).
fn acceptable_token(value: &str, now_ms: i64, current_expiry: i64) -> Option<String> {
    // A cookie value can be percent-encoded; a JWT never carries a `%`.
    let candidate = if value.contains('%') {
        percent_decode(value).and_then(|v| bare_token(&v))
    } else {
        bare_token(value)
    }?;
    let exp =
        oah::plaud::token::claims(&candidate).and_then(|c| oah::plaud::token::expires_at_ms(&c));
    if exp.is_some_and(|e| e <= now_ms || e <= current_expiry) {
        return None;
    }
    Some(candidate)
}

/// The `pld_ut` cookie of the window's web session, if any. The page cannot always read the
/// cookie itself, so Rust asks the webview for it too.
fn cookie_token(window: &tauri::WebviewWindow) -> Option<String> {
    let cookies = window.cookies().ok()?;
    cookies
        .into_iter()
        .find(|c| {
            c.name() == "pld_ut"
                && c.domain()
                    .is_some_and(|d| d.ends_with("plaud.ai") || d.ends_with("plaud.cn"))
        })
        .map(|c| c.value().to_owned())
}

/// How a capture attempt ended.
pub(crate) enum Captured {
    Token(String),
    /// The window was closed before a token arrived.
    Closed,
    /// The time ran out while the window was still open.
    TimedOut,
}

/// Opens `url` in a window of its own, waits for a Plaud session token, and closes the window.
/// Values arrive from the page's navigation to `oah-token://` and from a cookie check; stale
/// tokens are skipped and the wait continues. The shared half of the interactive sign-in and
/// the background refresh (spec/desktop.md 11.1 and 11.2).
pub(crate) async fn capture_token(
    app: &AppHandle,
    label: &'static str,
    title: &str,
    url: tauri::Url,
    visible: bool,
    timeout: Duration,
    current_expiry: i64,
) -> Result<Captured, String> {
    if let Some(old) = app.get_webview_window(label) {
        let _ = old.close();
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let closed = Arc::new(AtomicBool::new(false));
    let nav_app = app.clone();
    let nav_tx = tx.clone();
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(title)
        .inner_size(480.0, 720.0)
        .visible(visible)
        .initialization_script(PLAUD_SCRIPT)
        .on_navigation(move |target| {
            if target.scheme() != TOKEN_SCHEME {
                return true;
            }
            // The hand-off URL says nothing about who sent it; accept it only while the
            // window is showing Plaud's own site.
            let on_plaud = nav_app
                .get_webview_window(label)
                .and_then(|w| w.url().ok())
                .is_some_and(|u| {
                    u.scheme() == "https" && u.host_str().is_some_and(|h| PLAUD_HOSTS.contains(&h))
                });
            if on_plaud && let Some((_, value)) = target.query_pairs().find(|(k, _)| k == "v") {
                let _ = nav_tx.send(value.into_owned());
            }
            false
        })
        .build()
        .map_err(|e| e.to_string())?;
    window.on_window_event({
        let closed = closed.clone();
        move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                closed.store(true, Ordering::SeqCst);
            }
        }
    });

    // Re-run the read from Rust and check the cookie, so a hidden window's throttled timers
    // cannot stall the capture.
    let poller = tokio::spawn({
        let window = window.clone();
        let tx = tx.clone();
        let closed = closed.clone();
        async move {
            while !closed.load(Ordering::SeqCst) {
                if window.eval(PLAUD_SCRIPT).is_err() {
                    break;
                }
                if let Some(value) = cookie_token(&window) {
                    let _ = tx.send(value);
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    });
    // Only the window and the poller keep senders now, so `recv` ends when they do.
    drop(tx);

    let now = oah::db::now_ms();
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    let accepted = tokio::time::timeout(timeout, async {
        loop {
            tokio::select! {
                value = rx.recv() => match value {
                    Some(value) => {
                        if let Some(token) = acceptable_token(&value, now, current_expiry) {
                            return Some(token);
                        }
                    }
                    None => return None,
                },
                _ = tick.tick() => {
                    if closed.load(Ordering::SeqCst) {
                        return None;
                    }
                }
            }
        }
    })
    .await;
    poller.abort();
    let was_closed = closed.load(Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.close();
    }
    match accepted {
        Ok(Some(token)) => Ok(Captured::Token(token)),
        Ok(None) if was_closed => Ok(Captured::Closed),
        Ok(None) | Err(_) => Ok(Captured::TimedOut),
    }
}

/// Opens the one-time browser sign-in handoff in the user's default browser.
/// The URL is built from the app window origin so the frontend cannot choose a
/// destination or scheme for the native opener.
#[tauri::command]
pub fn open_plaud_browser(app: AppHandle, code: String) -> Result<(), String> {
    let url = plaud_browser_url(
        app.get_webview_window("main")
            .ok_or_else(|| "OpenAudioHub window is unavailable".to_owned())?
            .url()
            .map_err(|e| e.to_string())?,
        &code,
    )?;
    open_default_browser(&url)
}

fn plaud_browser_url(mut origin: tauri::Url, code: &str) -> Result<tauri::Url, String> {
    let host = origin.host_str().unwrap_or_default();
    if origin.scheme() != "http"
        || host != "127.0.0.1"
        || origin.port().is_none()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || code.len() != 43
        || !code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Invalid Plaud browser handoff".into());
    }
    origin.set_path("/connect/plaud");
    origin.set_query(None);
    origin.set_fragment(None);
    origin.query_pairs_mut().append_pair("code", code);
    Ok(origin)
}

#[cfg(target_os = "macos")]
pub(crate) fn open_default_browser(url: &tauri::Url) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url.as_str())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open the default browser: {e}"))
}

#[cfg(target_os = "windows")]
pub(crate) fn open_default_browser(url: &tauri::Url) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url.as_str()])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open the default browser: {e}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn open_default_browser(url: &tauri::Url) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url.as_str())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open the default browser: {e}"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn session_cookie_pairs_are_read() {
        assert_eq!(
            super::cookie_pair("oah_session=abc123; Path=/; HttpOnly; SameSite=Lax").as_deref(),
            Some("oah_session=abc123")
        );
        assert_eq!(super::cookie_pair("Path=/"), None);
        assert_eq!(super::cookie_pair("=x"), None);
    }

    #[test]
    fn plaud_token_forms() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
        assert_eq!(
            super::bare_token(&format!("\"bearer {jwt}\"")).as_deref(),
            Some(jwt)
        );
        assert_eq!(
            super::bare_token(&format!("Bearer {jwt}")).as_deref(),
            Some(jwt)
        );
        assert_eq!(super::bare_token(jwt).as_deref(), Some(jwt));
        assert_eq!(super::bare_token("\"not a token\""), None);
    }

    fn jwt(exp_seconds: i64) -> String {
        let header = oah::plaud::token::b64url_encode(br#"{"alg":"HS256","typ":"UT"}"#);
        let payload =
            oah::plaud::token::b64url_encode(format!(r#"{{"exp":{exp_seconds}}}"#).as_bytes());
        format!("{header}.{payload}.c2lnbmF0dXJlMTIzNDU2")
    }

    #[test]
    fn captured_tokens_are_cleaned_and_checked() {
        let now = 1_000_000_000_000_i64;
        let fresh = jwt(now / 1000 + 600);
        let stale = jwt(now / 1000 - 60);
        let short = jwt(now / 1000 + 30);
        assert_eq!(
            super::acceptable_token(&format!("\"bearer {fresh}\""), now, 0).as_deref(),
            Some(fresh.as_str())
        );
        // A URL-encoded cookie value is decoded before it is read.
        let encoded = format!("bearer%20{fresh}");
        assert_eq!(
            super::acceptable_token(&encoded, now, 0).as_deref(),
            Some(fresh.as_str())
        );
        assert_eq!(super::acceptable_token(&stale, now, 0), None);
        assert_eq!(super::acceptable_token(&short, now, now + 60_000), None);
        assert_eq!(super::acceptable_token("not a token", now, 0), None);
    }

    #[test]
    fn percent_escapes_decode_or_fail() {
        assert_eq!(super::percent_decode("a%20b"), Some("a b".to_owned()));
        assert_eq!(super::percent_decode("plain"), None);
        assert_eq!(super::percent_decode("bad%zz"), None);
        assert_eq!(super::percent_decode("short%2"), None);
    }

    #[test]
    fn download_names_are_safe_path_parts() {
        assert_eq!(super::safe_download_name("../notes\n.txt"), "notes.txt");
        assert_eq!(super::safe_download_name("..."), "download");
        assert_eq!(super::safe_download_name("東京.txt"), "東京.txt");
        assert_eq!(super::safe_download_name(&"x".repeat(201)).len(), 200);
    }

    #[test]
    fn plaud_browser_handoff_uses_only_local_origin_and_code() {
        let code = "a".repeat(43);
        let url = super::plaud_browser_url(
            tauri::Url::parse("http://127.0.0.1:38401/settings/plaud-account").unwrap(),
            &code,
        )
        .unwrap();
        assert_eq!(
            url.as_str(),
            format!("http://127.0.0.1:38401/connect/plaud?code={code}")
        );
        assert!(
            super::plaud_browser_url(
                tauri::Url::parse("https://127.0.0.1:38401/").unwrap(),
                &code
            )
            .is_err()
        );
        assert!(
            super::plaud_browser_url(tauri::Url::parse("http://localhost:38401/").unwrap(), &code)
                .is_err()
        );
        assert!(
            super::plaud_browser_url(
                tauri::Url::parse("http://user@127.0.0.1:38401/").unwrap(),
                &code
            )
            .is_err()
        );
        assert!(
            super::plaud_browser_url(
                tauri::Url::parse("http://127.0.0.1:38401/").unwrap(),
                "https://example.test"
            )
            .is_err()
        );
    }
}

/// Debug builds only: lets an automated check confirm the page can reach the bridge.
#[cfg(debug_assertions)]
#[tauri::command]
pub fn selftest_report(shared: State<'_, Shared>, value: String) {
    files::log(&shared.data_dir, &format!("selftest: {value}"));
}

#[cfg(test)]
mod bridge_script_tests {
    use super::*;

    #[test]
    fn the_script_carries_the_settling_language() {
        let script = bridge_script("ja");
        assert!(script.contains("initialLocale: \"ja\""), "{script}");
        assert!(script.contains("version: 7"));
        assert!(script.contains("setLocale"));
        assert!(script.contains("onLocaleChange"));
    }

    #[test]
    fn every_bridge_method_the_page_uses_is_defined() {
        let script = bridge_script("en");
        for method in [
            "getPreferences",
            "setPreferences",
            "pickFolder",
            "saveTextFile",
            "downloadRecordings",
            "reconnect",
            "setLocale",
            "onLocaleChange",
        ] {
            assert!(
                script.contains(&format!("{method}:")),
                "{method} is missing"
            );
        }
    }
}
