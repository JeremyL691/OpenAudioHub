//! The menu-bar item and the actions it starts (spec/desktop.md sections 6 and 10).
//! Labels follow the interface language. Sync is not here: it runs in the server.

use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::bridge::Shared;
use crate::files;
use crate::i18n;

/// Written by Edit Configuration when `openaudiohub.env` is missing (spec/desktop.md 3.3).
const CONFIG_TEMPLATE: &str = "# OpenAudioHub settings. Only the keys listed in the documentation are read.\n# Restart the app after changing this file.\n";
const KEYS_FILE_NAME: &str = "openaudiohub-keys.json";
/// The menu-bar icon, an 18pt monochrome template image (spec/desktop.md 8.1).
/// The 2x file is used on purpose: tray-icon scales the image to 18pt of height, so its
/// 36px of content stay sharp on a Retina display.
const TRAY_ICON: &[u8] = include_bytes!("../icons/trayTemplate@2x.png");

/// The Launch at Login item, kept in app state so the preferences bridge can update its check mark.
pub struct LoginItem(pub CheckMenuItem<Wry>);

/// The tray and its menu, so a language change can rebuild the labels in place.
pub struct TrayMenu {
    pub tray: tauri::tray::TrayIcon<Wry>,
}

/// The menu items whose labels change with the language, so they can be rebuilt.
struct Labels {
    open: MenuItem<Wry>,
    data: MenuItem<Wry>,
    logs: MenuItem<Wry>,
    config: MenuItem<Wry>,
    keys: MenuItem<Wry>,
    login: CheckMenuItem<Wry>,
    language: Submenu<Wry>,
    quit: MenuItem<Wry>,
}

/// Builds the menu-bar item. The login item is enabled only in the packaged app.
pub fn install_tray(
    app: &tauri::App,
    show: bool,
    launch_at_login: bool,
    locale: &str,
) -> tauri::Result<()> {
    let labels = build_labels(app, launch_at_login, locale)?;
    let (sep1, sep2, sep3) = (
        PredefinedMenuItem::separator(app)?,
        PredefinedMenuItem::separator(app)?,
        PredefinedMenuItem::separator(app)?,
    );
    let menu = Menu::with_items(
        app,
        &[
            &labels.open,
            &sep1,
            &labels.data,
            &labels.logs,
            &labels.config,
            &labels.keys,
            &sep2,
            &labels.login,
            &labels.language,
            &sep3,
            &labels.quit,
        ],
    )?;
    app.manage(LoginItem(labels.login));

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
    let tray = tray.build(app)?;
    tray.set_visible(show)?;
    app.manage(TrayMenu { tray });
    Ok(())
}

/// The items whose labels follow the language, with the language list checked at `locale`.
fn build_labels<M: Manager<Wry>>(
    app: &M,
    launch_at_login: bool,
    locale: &str,
) -> tauri::Result<Labels> {
    let open = MenuItem::with_id(app, "open", i18n::t("menu.open"), true, None::<&str>)?;
    let data = MenuItem::with_id(app, "data", i18n::t("menu.data"), true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", i18n::t("menu.logs"), true, None::<&str>)?;
    let config = MenuItem::with_id(app, "config", i18n::t("menu.config"), true, None::<&str>)?;
    let keys = MenuItem::with_id(app, "keys", i18n::t("menu.keys"), true, None::<&str>)?;
    let login = CheckMenuItem::with_id(
        app,
        "login",
        i18n::t("menu.login"),
        !cfg!(debug_assertions),
        launch_at_login,
        None::<&str>,
    )?;
    let language = Submenu::with_id(app, "language", i18n::t("menu.language"), true)?;
    for (id, label) in LANGUAGE_MENU {
        let tag = append_tag(id);
        let entry = CheckMenuItem::with_id(app, id, label, true, tag == locale, None::<&str>)?;
        language.append(&entry)?;
    }
    let quit = MenuItem::with_id(app, "quit", i18n::t("menu.quit"), true, Some("CmdOrCtrl+Q"))?;
    Ok(Labels {
        open,
        data,
        logs,
        config,
        keys,
        login,
        language,
        quit,
    })
}

/// The four languages in the tray submenu, each shown in its own language.
const LANGUAGE_MENU: [(&str, &str); 4] = [
    ("lang-en", "English"),
    ("lang-zh-CN", "简体中文"),
    ("lang-ja", "日本語"),
    ("lang-ko", "한국어"),
];

/// The language tag inside a `lang-<tag>` item id.
fn append_tag(id: &str) -> &str {
    id.strip_prefix("lang-").unwrap_or(id)
}

/// The language tag a `lang-<tag>` item id stands for.
fn locale_of(id: &str) -> Option<&'static str> {
    LANGUAGE_MENU
        .iter()
        .find(|(item, _)| *item == id)
        .and_then(|(item, _)| i18n::normalize(append_tag(item)))
}

/// Rebuilds every label in the new language, for the bridge's language change.
pub fn relabel_public(app: &AppHandle, locale: &str) -> tauri::Result<()> {
    relabel(app, locale)
}

/// Rebuilds every label in the new language, keeping the menu open state and check marks.
fn relabel(app: &AppHandle, locale: &str) -> tauri::Result<()> {
    let Some(shared) = app.try_state::<Shared>() else {
        return Ok(());
    };
    let (launch_at_login, show_tray) = {
        let config = shared.config.lock().unwrap_or_else(|e| e.into_inner());
        (
            config.launch_at_login.unwrap_or(false),
            config.show_tray.unwrap_or(true),
        )
    };
    let labels = build_labels(app, launch_at_login, locale)?;
    let menu = Menu::with_items(
        app,
        &[
            &labels.open,
            &PredefinedMenuItem::separator(app)?,
            &labels.data,
            &labels.logs,
            &labels.config,
            &labels.keys,
            &PredefinedMenuItem::separator(app)?,
            &labels.login,
            &labels.language,
            &PredefinedMenuItem::separator(app)?,
            &labels.quit,
        ],
    )?;
    if let Some(tray_state) = app.try_state::<TrayMenu>() {
        tray_state.tray.set_menu(Some(menu))?;
    }
    app.manage(LoginItem(labels.login));
    if let Some(tray_state) = app.try_state::<TrayMenu>() {
        let _ = tray_state.tray.set_visible(show_tray);
    }
    Ok(())
}

/// Keeps the Launch at Login check mark in step with the saved and system setting.
pub fn set_login_checked(app: &AppHandle, on: bool) {
    if let Some(item) = app.try_state::<LoginItem>() {
        let _ = item.0.set_checked(on);
    }
}

/// Switches the language from the tray menu, saves it, and tells the window's page.
pub fn choose_language(app: &AppHandle, locale: &'static str) {
    let Some(shared) = app.try_state::<Shared>() else {
        return;
    };
    {
        let mut config = shared.config.lock().unwrap_or_else(|e| e.into_inner());
        config.locale = Some(locale.to_owned());
        config.save(&shared.data_dir);
    }
    i18n::set(locale);
    if let Err(e) = relabel(app, locale) {
        files::log(
            &shared.data_dir,
            &format!("could not rebuild the menu: {e}"),
        );
    }
    crate::apply_locale(app, locale);
}

fn on_event(app: &AppHandle, id: &str) {
    if let Some(locale) = locale_of(id) {
        choose_language(app, locale);
        return;
    }
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
    let mut command = Command::new("open");
    if as_text {
        command.arg("-t");
    }
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
        .message(i18n::t("dialog.exportKeysBody"))
        .title(i18n::t("dialog.exportKeysTitle"))
        .buttons(MessageDialogButtons::OkCancelCustom(
            i18n::t("dialog.exportKeysConfirm"),
            i18n::t("dialog.cancel"),
        ))
        .show(move |confirmed| {
            if !confirmed {
                return;
            }
            picked_app
                .dialog()
                .file()
                .set_title(i18n::t("dialog.exportKeysSaveTitle"))
                .set_file_name(KEYS_FILE_NAME)
                .save_file(move |picked| {
                    let Some(picked) = picked else { return };
                    let outcome = picked
                        .into_path()
                        .map_err(|e| e.to_string())
                        .and_then(|path| export_copy(&dir, &path));
                    match outcome {
                        Ok(()) => files::log(&dir, "exported the keys to a file the user chose"),
                        Err(reason) => {
                            files::log(&dir, &format!("the keys could not be exported: {reason}"));
                            warned_app
                                .dialog()
                                .message(reason)
                                .title(i18n::t("dialog.exportKeysFailedTitle"))
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
        .map_err(|e| i18n::tf("error.keysUnreadable", &[("reason", &e.to_string())]))?;
    files::write_atomic(dest, &text).map_err(|e| {
        i18n::tf(
            "error.keysUnwritable",
            &[
                ("path", &dest.display().to_string()),
                ("reason", &e.to_string()),
            ],
        )
    })
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
