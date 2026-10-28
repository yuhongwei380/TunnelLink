use std::path::Path;

use serde_json::{Value, json};

fn merge_value(target: &mut Value, source: Value) {
    match source {
        Value::Object(source_map) if matches!(target, Value::Object(_)) => {
            if let Value::Object(target_map) = target {
                for (key, value) in source_map {
                    merge_value(target_map.entry(key).or_insert(Value::Null), value);
                }
            }
        }
        other => *target = other,
    }
}

fn main() {
    // The Windows executable embeds the ICO during the Cargo build. Keep the
    // resource step invalidated when the generated desktop icon changes.
    println!("cargo:rerun-if-changed=icons/icon.ico");

    // Bake the private quick-configuration overlay (private/ui-copy.json) on
    // top of config/ui-copy.json so both the embedded default and the
    // first-run runtime seed carry it. The private file stays git-ignored.
    println!("cargo:rerun-if-changed=../config/ui-copy.json");
    println!("cargo:rerun-if-changed=../private/ui-copy.json");
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let root = Path::new(&manifest_dir).parent().expect("workspace root");
    let mut effective: Value = std::fs::read(root.join("config/ui-copy.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| json!({}));
    if let Ok(bytes) = std::fs::read(root.join("private/ui-copy.json")) {
        let overlay = serde_json::from_slice::<Value>(&bytes)
            .unwrap_or_else(|error| panic!("private/ui-copy.json is not valid JSON: {error}"));
        merge_value(&mut effective, overlay);
    }
    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR");
    std::fs::write(
        Path::new(&out_dir).join("ui-copy-effective.json"),
        serde_json::to_vec_pretty(&effective).expect("serialize effective ui copy"),
    )
    .expect("write ui-copy-effective.json");

    let windows =
        tauri_build::WindowsAttributes::new().app_manifest(include_str!("windows.manifest"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("Tauri build failed");
}
