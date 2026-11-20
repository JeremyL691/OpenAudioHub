#[test]
fn the_page_can_set_the_shell_language() {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
    assert!(
        capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|permission| permission == "allow-set-locale")
    );
    let manifest: serde_json::Value =
        serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
    assert_eq!(
        manifest["__app-acl__"]["permissions"]["allow-set-locale"]["commands"]["allow"],
        serde_json::json!(["set_locale"])
    );
}
