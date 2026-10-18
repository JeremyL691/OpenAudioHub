fn main() {
    // App commands must be declared so the capability can grant them to the app's own page.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "prefs_get",
        "prefs_set",
        "open_plaud_browser",
        "pick_folder",
        "save_text_file",
        "desktop_secret",
        "selftest_report",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("tauri build step");
}
