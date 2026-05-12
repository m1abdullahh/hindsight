use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::time::sleep;
use user_idle::UserIdle;

#[derive(Clone, Serialize)]
struct ActivityPayload {
    idle_seconds: u64,
}

/// Polls OS-level idle time once per second and emits `activity-changed`
/// whenever the value crosses a whole-second boundary. The renderer applies
/// its own idle threshold against the most recent value.
/// Event name uses a dash because Tauri 2 rejects `.` in event names.
pub fn spawn(app: AppHandle) -> tokio::task::JoinHandle<()> {
    tracing::info!("idle_watcher: starting");
    tokio::spawn(async move {
        let mut last_emitted: Option<u64> = None;
        let mut last_logged: Option<u64> = None;
        loop {
            let idle_seconds = match UserIdle::get_time() {
                Ok(t) => t.as_seconds(),
                Err(e) => {
                    tracing::warn!(err = %e, "idle query failed; assuming active");
                    0
                }
            };
            if last_emitted != Some(idle_seconds) {
                let emit_result = app.emit("activity-changed", ActivityPayload { idle_seconds });
                if let Err(e) = emit_result {
                    tracing::warn!(err = %e, "failed to emit activity-changed");
                }
                last_emitted = Some(idle_seconds);
            }
            // Log a coarse heartbeat: every 10s so the dev terminal shows the
            // watcher is alive without flooding output.
            if idle_seconds % 10 == 0 && Some(idle_seconds) != last_logged {
                tracing::info!(idle_seconds, "idle_watcher tick");
                last_logged = Some(idle_seconds);
            }
            sleep(Duration::from_secs(1)).await;
        }
    })
}
