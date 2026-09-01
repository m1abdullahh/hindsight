use std::sync::Arc;
use std::time::Duration;

use rand::Rng;
use serde::Deserialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};
#[cfg(target_os = "macos")]
use tauri_plugin_notification::NotificationExt;
use tokio::sync::watch;
use tokio::time::{sleep_until, Instant};

use crate::activity::ActivityCounters;
use crate::capture;

#[derive(Clone, Debug, Deserialize)]
pub struct TrackingState {
    pub time_entry_id: String,
    pub interval_minutes: u32,
    #[serde(default)]
    pub paused: bool,
}

pub fn spawn(
    app: AppHandle,
    db: SqlitePool,
    counters: Arc<ActivityCounters>,
    mut state_rx: watch::Receiver<Option<TrackingState>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            // Wait until tracking is active (not None, not paused).
            let state = loop {
                let snapshot = state_rx.borrow().clone();
                match snapshot {
                    Some(s) if !s.paused => break s,
                    _ => {
                        if state_rx.changed().await.is_err() {
                            return;
                        }
                    }
                }
            };

            let interval_secs = (state.interval_minutes.max(1) as u64) * 60;
            // Random offset in [15, intervalSeconds - 15]; clamp for very
            // short intervals so the rng range is always non-empty.
            let max_offset = interval_secs.saturating_sub(15).max(16);
            let offset_secs = {
                let mut rng = rand::thread_rng();
                rng.gen_range(15u64..max_offset)
            };

            tracing::debug!(
                offset_secs,
                interval_minutes = state.interval_minutes,
                "scheduling next capture"
            );

            // Wait for the deadline OR a state change (Stop button).
            let deadline = Instant::now() + Duration::from_secs(offset_secs);
            tokio::select! {
                _ = sleep_until(deadline) => {}
                _ = state_rx.changed() => {
                    continue;
                }
            }

            // Re-check state — Stop or Pause may have been pressed at the deadline.
            match state_rx.borrow().clone() {
                Some(s) if !s.paused => {}
                _ => continue,
            }

            // Never capture while the session is locked. The lock-pause
            // normally arrives via lock_watcher → webview → set_tracking,
            // but a locked machine can suspend the hidden webview, so that
            // round trip may not land until unlock. state_rx would then
            // still read "active" — check the OS directly instead of
            // trusting it. Skipping reschedules a fresh window, so captures
            // resume automatically after unlock.
            if crate::lock_watcher::detect_locked().await {
                tracing::info!("session locked at capture deadline; skipping capture");
                continue;
            }

            // Capture (blocking; runs on a Tokio blocking pool to avoid
            // stalling the runtime). One shot per attached monitor.
            let capture_result = tokio::task::spawn_blocking(capture::capture_all).await;

            match capture_result {
                Ok(Ok(shots)) => {
                    // Activity counters represent input events for the whole
                    // capture event, not per-monitor. Attribute them to the
                    // first persisted row (monitor 0) and zero on the rest so
                    // a SUM across rows still equals the real event count.
                    let (kb, mouse) = counters.read_and_reset();
                    let mut any_persisted = false;
                    for (i, shot) in shots.into_iter().enumerate() {
                        let monitor_kb = if i == 0 { kb } else { 0 };
                        let monitor_mouse = if i == 0 { mouse } else { 0 };
                        if let Err(e) = persist_capture(
                            &db,
                            &state.time_entry_id,
                            shot,
                            monitor_kb,
                            monitor_mouse,
                        )
                        .await
                        {
                            tracing::error!(err = %e, "failed to persist capture");
                        } else {
                            any_persisted = true;
                        }
                    }
                    if any_persisted {
                        emit_outbox_changed(&app, &db).await;
                        // One toast per capture event, regardless of monitor count.
                        notify_capture(&app);
                    }
                }
                Ok(Err(e)) => {
                    tracing::warn!(err = %e, "capture failed");
                }
                Err(join_err) => {
                    tracing::error!(err = %join_err, "capture task join failed");
                }
            }

            // Wait the remainder of this window before scheduling the next,
            // but stay responsive to Stop / Pause.
            let tail_deadline =
                Instant::now() + Duration::from_secs(interval_secs - offset_secs);
            tokio::select! {
                _ = sleep_until(tail_deadline) => {}
                _ = state_rx.changed() => {}
            }
        }
    })
}

async fn persist_capture(
    db: &SqlitePool,
    time_entry_id: &str,
    shot: capture::CapturedScreenshot,
    keyboard_count: u64,
    mouse_count: u64,
) -> Result<(), sqlx::Error> {
    let id = ulid::Ulid::new().to_string();
    let size_bytes = shot.bytes.len() as i64;
    sqlx::query(
        "INSERT INTO outbox_screenshots
         (id, time_entry_id, captured_at_ms, monitor_index, width, height,
          bytes, size_bytes, keyboard_count, mouse_count, next_attempt_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0)",
    )
    .bind(&id)
    .bind(time_entry_id)
    .bind(shot.captured_at_ms)
    .bind(shot.monitor_index as i64)
    .bind(shot.width as i64)
    .bind(shot.height as i64)
    .bind(&shot.bytes)
    .bind(size_bytes)
    .bind(keyboard_count as i64)
    .bind(mouse_count as i64)
    .execute(db)
    .await?;
    Ok(())
}

#[cfg_attr(target_os = "windows", allow(unused_variables))]
fn notify_capture(app: &AppHandle) {
    // On Windows we go straight to tauri-winrt-notification with our AUMID.
    // tauri-plugin-notification deliberately skips setting the AUMID when the
    // exe is under target/debug or target/release, which makes Windows
    // attribute dev-mode toasts to PowerShell. Calling the underlying lib
    // directly with our registered AUMID fixes that.
    #[cfg(target_os = "windows")]
    {
        use tauri_winrt_notification::Toast;
        if let Err(e) = Toast::new("app.hindsight.desktop")
            .title("Hindsight")
            .text1("Screenshot captured")
            .show()
        {
            tracing::warn!(err = %e, "failed to show capture notification (winrt)");
        }
        return;
    }

    // macOS still goes through the plugin, which works there.
    #[cfg(target_os = "macos")]
    {
        if let Err(e) = app
            .notification()
            .builder()
            .title("Hindsight")
            .body("Screenshot captured")
            .show()
        {
            tracing::warn!(err = %e, "failed to show capture notification");
        }
    }

    // On Linux the plugin does not surface a banner: it fire-and-forgets
    // notify_rust inside a tokio task and discards the result, so any failure
    // is silent (which is what we hit — audible sound, no visible notice). We
    // already depend on zbus for lock detection, so issue the D-Bus
    // notification ourselves, which displays reliably. The sound is played
    // separately because GNOME Shell ignores notification sound hints.
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        show_capture_notification_linux();
        play_capture_sound();
    }
}

/// Shows the "Screenshot captured" banner on Linux via a direct
/// `org.freedesktop.Notifications.Notify` call. Mirrors the zbus idiom in
/// `lock_watcher`. Spawned onto the async runtime and best-effort: a desktop
/// with no notification daemon just gets no banner, never a blocked capture.
#[cfg(target_os = "linux")]
fn show_capture_notification_linux() {
    tauri::async_runtime::spawn(async {
        use std::collections::HashMap;
        use zbus::zvariant::Value;

        let conn = match zbus::Connection::session().await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(err = %e, "dbus session connect failed for capture notification");
                return;
            }
        };

        let actions: Vec<&str> = Vec::new();
        let hints: HashMap<&str, Value<'_>> = HashMap::new();
        if let Err(e) = conn
            .call_method(
                Some("org.freedesktop.Notifications"),
                "/org/freedesktop/Notifications",
                Some("org.freedesktop.Notifications"),
                "Notify",
                &(
                    "Hindsight",           // app_name
                    0u32,                  // replaces_id: 0 = new notification
                    "camera-photo",        // app_icon: themed icon name
                    "Hindsight",           // summary
                    "Screenshot captured", // body
                    actions,
                    hints,
                    5000i32, // expire after 5s, like any transient banner
                ),
            )
            .await
        {
            tracing::warn!(err = %e, "failed to show capture notification (dbus)");
        }
    });
}

/// Plays the capture alert on Linux by shelling out to a sound player, because
/// GNOME Shell does not play notification sound hints.
///
/// Runs on a detached thread and reaps the short-lived player (via `status()`)
/// so a capture every minute can't leave a trail of zombie processes. Players
/// are tried most-portable-first; the first that exits cleanly wins, and a
/// desktop with none of them just stays silent — a missing sound never blocks
/// or delays a capture.
#[cfg(target_os = "linux")]
fn play_capture_sound() {
    std::thread::spawn(|| {
        use std::path::Path;
        use std::process::{Command, Stdio};

        fn run(cmd: &str, args: &[&str]) -> bool {
            Command::new(cmd)
                .args(args)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        }

        // The freedesktop sound theme installs here on every compliant distro.
        // `screen-capture` is its dedicated shutter sound; `camera-shutter` is
        // the fallback for a theme that lacks it.
        const CANDIDATES: [&str; 2] = [
            "/usr/share/sounds/freedesktop/stereo/screen-capture.oga",
            "/usr/share/sounds/freedesktop/stereo/camera-shutter.oga",
        ];

        if let Some(file) = CANDIDATES.iter().copied().find(|p| Path::new(p).exists()) {
            if run("paplay", &[file]) || run("pw-play", &[file]) || run("canberra-gtk-play", &["-f", file]) {
                return;
            }
        }
        // No theme file on disk (or no raw player present): let libcanberra
        // resolve the sound from the active theme by name as a last resort.
        let _ = run("canberra-gtk-play", &["-i", "screen-capture"]);
    });
}

pub async fn emit_outbox_changed(app: &AppHandle, db: &SqlitePool) {
    let pending: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM outbox_screenshots WHERE uploaded_at IS NULL")
            .fetch_one(db)
            .await
            .unwrap_or(0);
    let _ = app.emit("outbox-changed", serde_json::json!({ "pending": pending }));
}

#[cfg(test)]
mod tests {
    use rand::Rng;

    #[test]
    fn random_offset_respects_min_and_max() {
        let interval_secs: u64 = 10 * 60;
        for _ in 0..1000 {
            let mut rng = rand::thread_rng();
            let max = interval_secs.saturating_sub(15).max(16);
            let offset = rng.gen_range(15u64..max);
            assert!(offset >= 15);
            assert!(offset <= interval_secs - 15);
        }
    }

    #[test]
    fn very_short_interval_falls_back_to_safe_min() {
        let interval_secs: u64 = 30;
        let mut rng = rand::thread_rng();
        let max = interval_secs.saturating_sub(15).max(16);
        let offset = rng.gen_range(15u64..max);
        assert!(offset >= 15);
    }
}
