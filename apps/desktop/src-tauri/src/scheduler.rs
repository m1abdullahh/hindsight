use std::sync::Arc;
use std::time::Duration;

use rand::Rng;
use serde::Deserialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};
#[cfg(not(target_os = "windows"))]
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

    #[cfg(not(target_os = "windows"))]
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
