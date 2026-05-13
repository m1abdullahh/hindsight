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
mod permissions;
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

/// Shows a Windows toast notifying the user they just returned from idle.
/// Uses our AUMID directly so it shows "Hindsight" as the source even in dev.
/// The actual Keep/Discard buttons live in the inline banner inside the app —
/// this toast is just a heads-up since the user is usually somewhere else
/// (browser, other app) when they come back from being away.
#[tauri::command]
fn show_idle_resume_toast(idle_seconds: u64) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tauri_winrt_notification::Toast;
        let label = format_idle_duration(idle_seconds);
        Toast::new("app.hindsight.desktop")
            .title("Hindsight")
            .text1(&format!("You were idle for {}", label))
            .text2("Open Hindsight to keep or discard this time.")
            .show()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = idle_seconds;
    }
    Ok(())
}

fn screen_capture_marker_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("screen_capture_granted")
}

/// Reports OS-level permission status for screen recording. On non-macOS
/// platforms this always returns Granted so the renderer can skip the gate.
#[tauri::command]
fn check_screen_capture_permission(app: tauri::AppHandle) -> permissions::PermissionStatus {
    permissions::check_screen_capture(&screen_capture_marker_path(&app))
}

/// Triggers the macOS permission dialog (first call only). Returns the
/// post-request status so the renderer can update its gate immediately.
#[tauri::command]
fn request_screen_capture_permission(app: tauri::AppHandle) -> permissions::PermissionStatus {
    permissions::request_screen_capture(&screen_capture_marker_path(&app))
}

/// Opens System Settings → Privacy & Security → Screen Recording. macOS only;
/// no-op on other platforms. Useful when the user has previously denied and
/// we can no longer trigger the OS dialog from inside the app.
#[tauri::command]
async fn open_screen_capture_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_shell::ShellExt;
        app.shell()
            .open(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
                None,
            )
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn format_idle_duration(seconds: u64) -> String {
    if seconds < 60 {
        format!("{}s", seconds)
    } else {
        let m = seconds / 60;
        let s = seconds % 60;
        if s == 0 {
            format!("{}m", m)
        } else {
            format!("{}m {}s", m, s)
        }
    }
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

    // Resolution order:
    //   1. Runtime env (`API_BASE_URL`) — useful for `tauri dev` overrides.
    //   2. Compile-time env baked in by CI via `option_env!` — this is what
    //      packaged release builds use; end users never set env vars.
    //   3. localhost default for plain `cargo run`.
    let api_base = std::env::var("API_BASE_URL")
        .ok()
        .or_else(|| option_env!("API_BASE_URL").map(String::from))
        .unwrap_or_else(|| "http://localhost:3001".to_string());

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            get_device_token,
            set_device_token,
            clear_device_token,
            set_tracking,
            show_idle_resume_toast,
            check_screen_capture_permission,
            request_screen_capture_permission,
            open_screen_capture_settings,
        ])
        .setup(move |app| {
            // 1. Device-token store (file in app data dir; see auth.rs for why
            //    we don't use the OS credential store right now).
            let token_path = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("device_token");
            let tokens: Arc<DeviceTokenStore> = Arc::new(DeviceTokenStore::load(token_path));
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
                let _ = app.emit("tray-stop", ());
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
