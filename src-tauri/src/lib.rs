mod vpn;
#[cfg(windows)]
mod windows_process;
pub mod worker;

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

#[tauri::command]
fn app_get_ui_copy(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    const DEFAULT_UI_COPY: &[u8] = include_bytes!("../../config/ui-copy.json");
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join("ui-copy.json");
    if !path.exists() {
        std::fs::write(&path, DEFAULT_UI_COPY).map_err(|error| error.to_string())?;
    }
    let contents = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
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
