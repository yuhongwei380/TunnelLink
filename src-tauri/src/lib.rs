mod vpn;
#[cfg(windows)]
mod windows_process;
pub mod worker;

#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use vpn::Controller;

struct ExitApproval(AtomicBool);

#[tauri::command]
async fn vpn_connect(
    options: vpn::ConnectOptions,
    state: tauri::State<'_, Controller>,
) -> Result<serde_json::Value, String> {
    let controller = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || controller.connect(options))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn vpn_disconnect(state: tauri::State<'_, Controller>) -> Result<serde_json::Value, String> {
    let controller = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || controller.disconnect())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn vpn_status(state: tauri::State<'_, Controller>) -> serde_json::Value {
    state.status()
}
#[tauri::command]
fn vpn_get_logs(state: tauri::State<'_, Controller>) -> serde_json::Value {
    state.logs()
}
#[tauri::command]
fn vpn_clear_logs(state: tauri::State<'_, Controller>) -> serde_json::Value {
    state.clear_logs()
}
#[tauri::command]
async fn vpn_get_saved_credentials(
    state: tauri::State<'_, Controller>,
) -> Result<serde_json::Value, String> {
    let controller = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || controller.credentials())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
fn app_get_meta(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({ "name": app.package_info().name, "version": app.package_info().version.to_string(), "platform": std::env::consts::OS })
}

#[cfg(target_os = "macos")]
fn macos_app_bundle(app: &tauri::AppHandle) -> Option<PathBuf> {
    // Tauri's resource directory is stable even when macOS launches an app
    // through a disk-image mount or an app-translocation path. Fall back to
    // current_exe for development builds that do not have a resource bundle.
    if let Ok(resources) = app.path().resource_dir() {
        if let Some(contents) = resources.parent() {
            if contents.file_name().is_some_and(|name| name == "Contents") {
                if let Some(bundle) = contents.parent() {
                    if bundle
                        .extension()
                        .is_some_and(|extension| extension == "app")
                    {
                        return Some(bundle.to_path_buf());
                    }
                }
            }
        }
    }
    let executable = std::env::current_exe().ok()?;
    executable
        .ancestors()
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))
        .map(Path::to_path_buf)
}

#[cfg(target_os = "macos")]
fn macos_app_is_installed(bundle: &Path) -> bool {
    if bundle.parent() == Some(Path::new("/Applications")) {
        return true;
    }
    match (std::env::var_os("HOME"), bundle.parent()) {
        (Some(home), Some(parent)) => PathBuf::from(home).join("Applications") == parent,
        _ => false,
    }
}

#[tauri::command]
fn app_get_installation_state(app: tauri::AppHandle) -> serde_json::Value {
    #[cfg(target_os = "macos")]
    {
        let needs_install = macos_app_bundle(&app)
            .map(|bundle| !macos_app_is_installed(&bundle))
            .unwrap_or(false);
        return serde_json::json!({ "needsInstall": needs_install, "platform": "macos" });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        serde_json::json!({ "needsInstall": false, "platform": std::env::consts::OS })
    }
}

#[tauri::command]
fn app_install_to_applications(
    app: tauri::AppHandle,
    approval: tauri::State<'_, ExitApproval>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let bundle = macos_app_bundle(&app).ok_or_else(|| {
            "Unable to locate the application bundle. Open the app from a macOS .app package."
                .to_string()
        })?;
        let name = bundle
            .file_name()
            .ok_or_else(|| "Unable to determine the application name.".to_string())?;
        let target = Path::new("/Applications").join(name);
        let copy = Command::new("/usr/bin/ditto")
            .arg("--rsrc")
            .arg("--extattr")
            .arg(&bundle)
            .arg(&target)
            .status()
            .map_err(|error| format!("Unable to copy the app: {error}"))?;
        if !copy.success() {
            return Err("macOS did not allow copying the app to Applications.".to_string());
        }
        let open = Command::new("/usr/bin/open")
            .arg(&target)
            .status()
            .map_err(|error| format!("Unable to reopen the copied app: {error}"))?;
        if !open.success() {
            return Err("The copied app could not be opened from Applications.".to_string());
        }
        approval.0.store(true, Ordering::SeqCst);
        app.exit(0);
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, approval);
        Err("Moving the app to Applications is only available on macOS.".to_string())
    }
}

#[tauri::command]
fn app_get_ui_copy(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    // Baked at compile time: config/ui-copy.json with the git-ignored
    // private/ui-copy.json quick-configuration overlay already merged in.
    const EFFECTIVE_UI_COPY: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/ui-copy-effective.json"));
    const BUNDLED_UI_COPY: &[u8] = include_bytes!("../../config/ui-copy.json");
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join("ui-copy.json");
    if !path.exists() {
        std::fs::write(&path, EFFECTIVE_UI_COPY).map_err(|error| error.to_string())?;
        return serde_json::from_slice(EFFECTIVE_UI_COPY).map_err(|error| error.to_string());
    }
    let contents = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let parsed: serde_json::Value =
        serde_json::from_str(&contents).map_err(|error| error.to_string())?;
    // A file that still equals the un-branded bundled default is a stale seed
    // from an earlier build; refresh it so the private overlay shows up after
    // upgrades. Any user-edited file is left untouched and wins.
    let bundled: serde_json::Value = serde_json::from_slice(BUNDLED_UI_COPY)
        .map_err(|error| error.to_string())?;
    if parsed == bundled {
        std::fs::write(&path, EFFECTIVE_UI_COPY).map_err(|error| error.to_string())?;
        return serde_json::from_slice(EFFECTIVE_UI_COPY).map_err(|error| error.to_string());
    }
    Ok(parsed)
}

#[tauri::command]
fn app_exit(
    app: tauri::AppHandle,
    state: tauri::State<'_, Controller>,
    approval: tauri::State<'_, ExitApproval>,
) {
    state.cancel();
    approval.0.store(true, Ordering::SeqCst);
    app.exit(0);
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            app.manage(Controller::new(app.config().identifier.clone()));
            app.manage(ExitApproval(AtomicBool::new(false)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vpn_connect,
            vpn_disconnect,
            vpn_status,
            vpn_get_logs,
            vpn_clear_logs,
            vpn_get_saved_credentials,
            app_get_meta,
            app_get_installation_state,
            app_install_to_applications,
            app_get_ui_copy,
            app_exit
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("app-close-requested", ());
            }
        })
        .build(tauri::generate_context!())
        .expect("Unable to initialize desktop client");
    app.run(|handle, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if !handle
                .state::<ExitApproval>()
                .0
                .swap(false, Ordering::SeqCst)
            {
                api.prevent_exit();
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("app-close-requested", ());
                }
            }
        }
        tauri::RunEvent::Exit => {
            handle.state::<Controller>().disconnect();
        }
        _ => {}
    });
}
