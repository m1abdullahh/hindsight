use std::sync::Arc;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};
use tokio::sync::watch;

mod activity;
mod auth;
mod capture;
mod db;
mod idle_watcher;
mod scheduler;
mod uploader;
#[cfg(target_os = "windows")]
mod win_aumid;

use activity::ActivityCounters;
use auth::DeviceTokenStore;
use scheduler::TrackingState;

// Shared state shimmed into Tauri so commands can talk to the workers.
struct TrackingChannel(watch::Sender<Option<TrackingState>>);

#[tauri::command]
fn get_device_token(tokens: tauri::State<'_, Arc<DeviceTokenStore>>) -> Option<String> {
    tokens.get()
}

#[tauri::command]
fn set_device_token(
    tokens: tauri::State<'_, Arc<DeviceTokenStore>>,
    token: String,
) -> Result<(), String> {
    tokens.set(token).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_device_token(
    tokens: tauri::State<'_, Arc<DeviceTokenStore>>,
) -> Result<(), String> {
    tokens.clear().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_tracking(
    state: tauri::State<'_, TrackingChannel>,
    tracking: Option<TrackingState>,
) -> Result<(), String> {
    state.0.send(tracking).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "hindsight_lib=info,warn".into()),
        )
        .init();

    // Without an explicit AUMID, Windows attributes our toast notifications to
    // the launching shell (PowerShell in `tauri dev`). Register early so the
    // notification plugin's first toast is already correctly identified.
    #[cfg(target_os = "windows")]
    win_aumid::register();

    let api_base = std::env::var("API_BASE_URL")
        .unwrap_or_else(|_| "http://localhost:3001".to_string());

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            get_device_token,
            set_device_token,
            clear_device_token,
            set_tracking,
        ])
        .setup(move |app| {
            // 1. Device-token store (Credential Manager / Keychain).
            let tokens: Arc<DeviceTokenStore> = Arc::new(DeviceTokenStore::load());
            app.manage(tokens.clone());

            // 2. Activity counters + OS event hooks.
            let counters: Arc<ActivityCounters> = ActivityCounters::new();
            activity::install_event_hooks(counters.clone());

            // 3. Tracking-state channel; React drives this via the
            //    `set_tracking` command, the scheduler watches it.
            let (state_tx, state_rx) = watch::channel::<Option<TrackingState>>(None);
            app.manage(TrackingChannel(state_tx));

            // 4. DB pool, capture scheduler, upload worker — all on the
            //    Tauri Tokio runtime.
            let app_handle = app.handle().clone();
            let api_base_for_async = api_base.clone();
            tauri::async_runtime::spawn(async move {
                let db = match db::open_pool(&app_handle).await {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::error!(err = %e, "DB open failed; workers not starting");
                        return;
                    }
                };
                scheduler::spawn(app_handle.clone(), db.clone(), counters, state_rx);
                uploader::spawn(app_handle.clone(), db, tokens, api_base_for_async);
                // Idle watcher uses tokio::spawn internally, so it must run
                // from inside a Tokio runtime context — i.e. after this async
                // block has started, not from setup() directly.
                idle_watcher::spawn(app_handle);
            });

            // 5. Tray icon + menu.
            setup_tray(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Hindsight");
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Hindsight", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop tracking", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &stop, &quit])?;

    let _tray = TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().expect("default window icon").clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => {
                app.exit(0);
            }
            "open" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "stop" => {
                let _ = app.emit("tray.stop", ());
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
