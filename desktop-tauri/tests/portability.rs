//! The shell targets macOS only (spec/desktop.md section 1). These checks keep a
//! conditional build for another platform, or a bundle target for one, from creeping back in.

const SOURCES: [(&str, &str); 4] = [
    ("main.rs", include_str!("../src/main.rs")),
    ("files.rs", include_str!("../src/files.rs")),
    ("bridge.rs", include_str!("../src/bridge.rs")),
    ("menu.rs", include_str!("../src/menu.rs")),
];

/// Names only a non-macOS branch can use: the Windows attribute, the Windows and
/// freedesktop openers, and the two data-folder variables for those platforms.
const FOREIGN: [&str; 5] = [
    "windows",
    "explorer",
    "xdg-open",
    "LOCALAPPDATA",
    "XDG_DATA_HOME",
];

#[test]
fn the_shell_source_has_no_branch_for_another_platform() {
    for (name, source) in SOURCES {
        for token in FOREIGN {
            assert!(!source.contains(token), "{name} still mentions {token}");
        }
        assert!(
            !source.contains("cfg(not(target_os = \"macos\"))"),
            "{name} still has a non-macOS branch"
        );
    }
}

#[test]
fn the_bundle_builds_the_app_and_the_disk_image_only() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json is JSON");
    let targets: Vec<&str> = config["bundle"]["targets"]
        .as_array()
        .expect("bundle.targets is a list")
        .iter()
        .map(|t| t.as_str().expect("a target is a string"))
        .collect();
    assert_eq!(targets, ["app", "dmg"]);
}
