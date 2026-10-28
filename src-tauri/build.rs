fn main() {
    // The Windows executable embeds the ICO during the Cargo build. Keep the
    // resource step invalidated when the generated desktop icon changes.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    let windows =
        tauri_build::WindowsAttributes::new().app_manifest(include_str!("windows.manifest"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("Tauri build failed");
}
