fn main() {
    let settings = "../../resources/settings/client-features.json";
    let profile = "../../resources/settings/client.ovpn";
    println!("cargo:rerun-if-changed={settings}");
    println!("cargo:rerun-if-changed={profile}");
    let raw = std::fs::read_to_string(settings).expect("Missing client-features.json");
    let value: serde_json::Value = serde_json::from_str(&raw).expect("Invalid client features");
    for (object, allowed) in [
        (&value, &["_comment", "builtinProfile", "profileImport"][..]),
        (
            &value["builtinProfile"],
            &["_comment", "enabled", "displayName", "description"][..],
        ),
        (&value["profileImport"], &["_comment", "enabled"][..]),
    ] {
        let object = object
            .as_object()
            .expect("Client feature groups must be objects");
        assert!(
            object.keys().all(|key| allowed.contains(&key.as_str())),
            "Unknown client feature field"
        );
    }
    for key in ["displayName", "description"] {
        if let Some(v) = value["builtinProfile"].get(key) {
            assert!(v.is_string(), "Built-in labels must be strings");
        }
    }
    let builtin = value["builtinProfile"]["enabled"]
        .as_bool()
        .expect("builtinProfile.enabled must be boolean");
    let import = value["profileImport"]["enabled"]
        .as_bool()
        .expect("profileImport.enabled must be boolean");
    assert!(
        builtin || import,
        "At least one profile feature must be enabled"
    );
    let contents = if builtin {
        std::fs::read_to_string(profile).expect("Missing built-in profile")
    } else {
        String::new()
    };
    let generated =
        format!("pub const FEATURES: &str = {raw:?};\npub const BUILTIN: &str = {contents:?};\n");
    std::fs::write(
        std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("client_features.rs"),
        generated,
    )
    .unwrap();
    // The Windows executable embeds the ICO during the Cargo build. Keep the
    // resource step invalidated when the generated desktop icon changes.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    let windows =
        tauri_build::WindowsAttributes::new().app_manifest(include_str!("windows.manifest"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("Tauri build failed");
}
