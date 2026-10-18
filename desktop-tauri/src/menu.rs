//! The menu-bar item and the actions it starts (spec/desktop.md sections 8.1, 8.2, 8.4 and 10).
//! Labels and their order follow the spec. Sync is not here: it runs in the server.

use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::bridge::Shared;
use crate::files;

/// Written by Edit Configuration when `openaudiohub.env` is missing (spec/desktop.md 3.3).
const CONFIG_TEMPLATE: &str = "# OpenAudioHub settings. Only the keys listed in the documentation are read.\n# Restart the app after changing this file.\n";
const KEYS_FILE_NAME: &str = "openaudiohub-keys.json";
/// The menu-bar icon, an 18pt monochrome template image (spec/desktop.md 8.1).
/// The 2x file is used on purpose: tray-icon scales the image to 18pt of height, so its
/// 36px of content stay sharp on a Retina display.
const TRAY_ICON: &[u8] = include_bytes!("../icons/trayTemplate@2x.png");

/// The Launch at Login item, kept in app state so the preferences bridge can update its check mark.
pub struct LoginItem(pub CheckMenuItem<Wry>);

/// Builds the menu-bar item. The login item is enabled only in the packaged app.
pub fn install_tray(app: &tauri::App, show: bool, launch_at_login: bool) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open OpenAudioHub", true, None::<&str>)?;
    let data = MenuItem::with_id(app, "data", "Open Data Folder", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "Open Logs Folder", true, None::<&str>)?;
    let config = MenuItem::with_id(app, "config", "Edit Configuration…", true, None::<&str>)?;
    let keys = MenuItem::with_id(app, "keys", "Export Keys…", true, None::<&str>)?;
    let login = CheckMenuItem::with_id(
        app,
        "login",
        "Launch at Login",
        !cfg!(debug_assertions),
        launch_at_login,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit OpenAudioHub", true, Some("CmdOrCtrl+Q"))?;
    let (sep1, sep2, sep3) = (
        PredefinedMenuItem::separator(app)?,
        PredefinedMenuItem::separator(app)?,
        PredefinedMenuItem::separator(app)?,
    );
    let menu = Menu::with_items(
        app,
        &[
            &open, &sep1, &data, &logs, &config, &keys, &sep2, &login, &sep3, &quit,
        ],
    )?;
    app.manage(LoginItem(login));

    let mut tray = TrayIconBuilder::with_id("tray")
        .menu(&menu)
        .tooltip("OpenAudioHub")
        .on_menu_event(|app, event| on_event(app, event.id.as_ref()));
    // The menu-bar icon: an 18pt monochrome template image macOS tints for light or
    // dark menu bars (spec/desktop.md 8.1). Falls back to the app icon when decoding fails.
    match tauri::image::Image::from_bytes(TRAY_ICON) {
        Ok(icon) => {
            tray = tray.icon(icon).icon_as_template(true);
        }
        Err(_) => {
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
        }
    }
    tray.build(app)?.set_visible(show)?;
    Ok(())
}

/// Keeps the Launch at Login check mark in step with the saved and system setting.
pub fn set_login_checked(app: &AppHandle, on: bool) {
    if let Some(item) = app.try_state::<LoginItem>() {
        let _ = item.0.set_checked(on);
    }
}

fn on_event(app: &AppHandle, id: &str) {
    match id {
        "open" => crate::show_main(app),
        "data" | "logs" => {
            let dir = data_dir(app);
            open_path(&dir, &dir, false);
        }
        "config" => edit_configuration(app),
        "keys" => export_keys(app),
        "login" => toggle_login(app),
        "quit" => app.exit(0),
        _ => {}
    }
}

fn data_dir(app: &AppHandle) -> PathBuf {
    app.state::<Shared>().data_dir.clone()
}

/// Opens a file or folder with the system's default app. Failures are logged only.
fn open_path(dir: &Path, path: &Path, as_text: bool) {
    let mut command = if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        if as_text {
            c.arg("-t");
        }
        c
    } else if cfg!(windows) {
        Command::new("explorer")
    } else {
        Command::new("xdg-open")
    };
    if let Err(e) = command.arg(path).spawn() {
        files::log(dir, &format!("could not open {}: {e}", path.display()));
    }
}

fn edit_configuration(app: &AppHandle) {
    let dir = data_dir(app);
    let path = dir.join("openaudiohub.env");
    if !path.exists()
        && let Err(e) = files::write_atomic(&path, CONFIG_TEMPLATE)
    {
        files::log(&dir, &format!("could not create openaudiohub.env: {e}"));
        return;
    }
    open_path(&dir, &path, true);
}

/// Warns, asks for a save location, then writes a copy of `secrets.json` there (spec 8.4).
fn export_keys(app: &AppHandle) {
    let dir = data_dir(app);
    let (warned_app, picked_app) = (app.clone(), app.clone());
    app.dialog()
        .message("The file contains the keys that protect your data. Store it somewhere safe and never share it.")
        .title("Export the encryption keys?")
        .buttons(MessageDialogButtons::OkCancelCustom("Export…".into(), "Cancel".into()))
        .show(move |confirmed| {
            if !confirmed {
                return;
            }
            picked_app
                .dialog()
                .file()
                .set_title("Export the encryption keys")
                .set_file_name(KEYS_FILE_NAME)
                .save_file(move |picked| {
                    let Some(picked) = picked else { return };
                    let outcome = picked.into_path().map_err(|e| e.to_string()).and_then(|path| export_copy(&dir, &path));
                    match outcome {
                        Ok(()) => files::log(&dir, "exported the keys to a file the user chose"),
                        Err(reason) => {
                            files::log(&dir, &format!("the keys could not be exported: {reason}"));
                            warned_app
                                .dialog()
                                .message(reason)
                                .title("The keys could not be exported")
                                .kind(MessageDialogKind::Error)
                                .show(|_| {});
                        }
                    }
                });
        });
}

/// Copies `secrets.json` byte for byte to `dest`, written atomically with mode 0600.
fn export_copy(dir: &Path, dest: &Path) -> Result<(), String> {
    let text = std::fs::read_to_string(dir.join("secrets.json"))
        .map_err(|e| format!("cannot read the keys file: {e}"))?;
    files::write_atomic(dest, &text).map_err(|e| format!("cannot write {}: {e}", dest.display()))
}

fn toggle_login(app: &AppHandle) {
    let dir = data_dir(app);
    let auto = app.autolaunch();
    let want = !auto.is_enabled().unwrap_or(false);
    let result = if want { auto.enable() } else { auto.disable() };
    if let Err(e) = &result {
        files::log(&dir, &format!("could not change launch at login: {e}"));
    }
    let now_on = if result.is_ok() {
        want
    } else {
        auto.is_enabled().unwrap_or(false)
    };
    set_login_checked(app, now_on);
    if result.is_ok() {
        let shared = app.state::<Shared>();
        let mut config = shared.config.lock().unwrap_or_else(|e| e.into_inner());
        config.launch_at_login = Some(now_on);
        config.save(&shared.data_dir);
    }
}
