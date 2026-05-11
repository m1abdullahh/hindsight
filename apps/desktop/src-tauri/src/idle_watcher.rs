use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::time::sleep;
use user_idle::UserIdle;

#[derive(Clone, Serialize)]
struct ActivityPayload {
    idle_seconds: u64,
}

/// Polls OS-level idle time once per second and emits `activity.changed`
/// whenever the value crosses a whole-second boundary. The renderer applies
/// its own idle threshold against the most recent value.
pub fn spawn(app: AppHandle) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut last_emitted: Option<u64> = None;
        loop {
            let idle_seconds = match UserIdle::get_time() {
                Ok(t) => t.as_seconds(),
                Err(e) => {
                    tracing::warn!(err = %e, "idle query failed; assuming active");
                    0
                }
            };
            if last_emitted != Some(idle_seconds) {
                let _ = app.emit("activity.changed", ActivityPayload { idle_seconds });
                last_emitted = Some(idle_seconds);
            }
            sleep(Duration::from_secs(1)).await;
        }
    })
}
