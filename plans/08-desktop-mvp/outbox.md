# Desktop MVP — Outbox + Upload Worker + Scheduler

Three Rust pieces sit between "user clicked Start" and "screenshot row is `processed` in Postgres":

1. **Capture scheduler** — a Tokio task that fires `capture_screenshot()` at a random offset within every `screenshotIntervalMinutes` window, then drops the result into the SQLite outbox.
2. **Outbox** — SQLite table with bytes + metadata + retry bookkeeping. Persists across app restarts.
3. **Upload worker** — second Tokio task that drains the outbox: presign → PUT → confirm → mark uploaded. One concurrent upload at a time.

This is the meat of the desktop client. Everything else is plumbing.

## SQLite outbox schema

`apps/desktop/src-tauri/migrations/001_outbox.sql`:

```sql
CREATE TABLE IF NOT EXISTS outbox_screenshots (
  id              TEXT PRIMARY KEY,
  time_entry_id   TEXT NOT NULL,
  captured_at_ms  INTEGER NOT NULL,
  monitor_index   INTEGER NOT NULL DEFAULT 0,
  width           INTEGER NOT NULL,
  height          INTEGER NOT NULL,
  bytes           BLOB NOT NULL,
  size_bytes      INTEGER NOT NULL,
  active_app      TEXT,
  active_window   TEXT,
  keyboard_count  INTEGER NOT NULL DEFAULT 0,
  mouse_count     INTEGER NOT NULL DEFAULT 0,
  screenshot_id   TEXT,         -- assigned by server on presign
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,   -- unix ms
  uploaded_at     INTEGER,
  last_error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox_screenshots (uploaded_at, next_attempt_at);

CREATE TABLE IF NOT EXISTS outbox_time_entries (
  -- Reserved for the offline-create path in Plan 09. Empty in v0.5.
  id              TEXT PRIMARY KEY,
  patch_json      TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  applied_at      INTEGER
);

CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**Why we store bytes in the DB instead of as files on disk:**

- One transactional unit per row. A row either has the bytes + metadata or it doesn't. Filesystem-vs-DB races have to be defended against.
- SQLite handles BLOB up to ~1 GB per row trivially. JPEGs are <500 KB.
- Easier to clean up — `DELETE FROM outbox_screenshots WHERE uploaded_at < ?` is one SQL statement.

**On Windows the DB lives at `%APPDATA%\app.hindsight.desktop\hindsight.db`** — Tauri's `app_data_dir()` returns the right path automatically.

The `app_state` table is for misc per-app key-value (last selected `org_id` / `project_id`, last successful sync time, etc.).

## DB initialization

`src-tauri/src/db.rs`:

```rust
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions, SqliteConnectOptions};
use std::path::PathBuf;
use std::str::FromStr;

pub async fn open_pool(app: &tauri::AppHandle) -> sqlx::Result<SqlitePool> {
    let dir = app
        .path()
        .app_data_dir()
        .expect("app data dir resolvable");
    std::fs::create_dir_all(&dir).ok();

    let db_path: PathBuf = dir.join("hindsight.db");
    let conn_str = format!("sqlite://{}", db_path.to_string_lossy());

    let opts = SqliteConnectOptions::from_str(&conn_str)?
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);

    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(opts)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}
```

WAL journal mode makes concurrent reads (capture writer, upload reader) safe. Pool is small — 4 connections is plenty for one capture task + one upload task + ad-hoc UI reads.

## Capture scheduler

`src-tauri/src/scheduler.rs`:

```rust
use std::sync::Arc;
use std::time::Duration;

use rand::Rng;
use sqlx::SqlitePool;
use tokio::sync::watch;
use tokio::time::sleep_until;
use tokio::time::Instant;

use crate::activity::ActivityCounters;
use crate::capture;

#[derive(Clone, Debug)]
pub struct TrackingState {
    pub time_entry_id: String,
    pub interval_minutes: u32,
}

/// Spawn the capture loop. Runs forever; each tick captures, persists to
/// outbox, and waits for the next random offset.
///
/// `state_rx` receives `Some(state)` when tracking starts, `None` when it
/// stops. The loop pauses while `None`.
pub fn spawn(
    db: SqlitePool,
    counters: Arc<ActivityCounters>,
    mut state_rx: watch::Receiver<Option<TrackingState>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            // Wait for tracking to start (or be re-started).
            let state = loop {
                let snapshot = state_rx.borrow().clone();
                match snapshot {
                    Some(s) => break s,
                    None => {
                        if state_rx.changed().await.is_err() {
                            return; // sender dropped
                        }
                    }
                }
            };

            let interval_secs = (state.interval_minutes * 60) as u64;
            // Random offset in [15s, intervalSeconds - 15s], per docs/06.
            let offset = {
                let mut rng = rand::thread_rng();
                rng.gen_range(15u64..interval_secs.saturating_sub(15).max(16))
            };

            let deadline = Instant::now() + Duration::from_secs(offset);
            tracing::debug!(
                offset_secs = offset,
                interval_minutes = state.interval_minutes,
                "scheduling next capture"
            );

            // Wait for either the deadline OR a state change (Stop button).
            tokio::select! {
                _ = sleep_until(deadline) => {}
                _ = state_rx.changed() => {
                    // State changed mid-window. Loop to re-evaluate.
                    continue;
                }
            }

            // Re-check state right before capturing — Stop may have happened
            // exactly at the deadline.
            if state_rx.borrow().is_none() {
                continue;
            }

            // Capture.
            match capture::capture_screenshot() {
                Ok(shot) => {
                    let (kb, mouse) = counters.read_and_reset();
                    if let Err(e) = persist_capture(
                        &db,
                        &state.time_entry_id,
                        shot,
                        kb,
                        mouse,
                    )
                    .await
                    {
                        tracing::error!(err = %e, "failed to persist capture");
                    }
                }
                Err(e) => {
                    tracing::warn!(err = %e, "capture failed");
                    // We don't bail on a single failed capture — the next tick
                    // will retry. Permission-denied surfaces in the UI separately.
                }
            }

            // Loop continues for the NEXT window. We wait the full interval
            // from now, then pick a new offset for that window.
            sleep_until(Instant::now() + Duration::from_secs(interval_secs.saturating_sub(offset)))
                .await;
        }
    })
}

async fn persist_capture(
    db: &SqlitePool,
    time_entry_id: &str,
    shot: capture::CapturedScreenshot,
    keyboard_count: u64,
    mouse_count: u64,
) -> sqlx::Result<()> {
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
```

The scheduler design avoids two common bugs:

1. **No drift over long sessions.** Each window is `interval_secs` from the _start_ of the previous window, not from when the capture happened to fire. Otherwise: a slow capture extends the next interval; you could lose minutes over a workday.
2. **Stop is responsive.** `tokio::select!` watches both the deadline and the state-channel — pressing Stop doesn't wait for the next capture to fire before unwinding.

## Upload worker

`src-tauri/src/uploader.rs`:

```rust
use std::time::Duration;

use reqwest::Client;
use sqlx::SqlitePool;
use serde::{Deserialize, Serialize};

use crate::auth::DeviceTokenStore;

const BACKOFF_MS: &[u64] = &[
    60_000,        // 1 min
    300_000,       // 5 min
    1_800_000,     // 30 min
    7_200_000,     // 2 hr
    21_600_000,    // 6 hr
    86_400_000,    // 24 hr cap
];

#[derive(Deserialize)]
struct PresignResponse {
    #[serde(rename = "screenshotId")]
    screenshot_id: String,
    #[serde(rename = "putUrl")]
    put_url: String,
}

#[derive(Serialize)]
struct PresignBody<'a> {
    #[serde(rename = "timeEntryId")]
    time_entry_id: &'a str,
    #[serde(rename = "capturedAt")]
    captured_at: String, // ISO 8601
    #[serde(rename = "monitorIndex")]
    monitor_index: i64,
    #[serde(rename = "contentType")]
    content_type: &'static str,
}

#[derive(Serialize)]
struct ConfirmBody {
    width: i64,
    height: i64,
    #[serde(rename = "activeApp", skip_serializing_if = "Option::is_none")]
    active_app: Option<String>,
    #[serde(rename = "activeWindowTitle", skip_serializing_if = "Option::is_none")]
    active_window: Option<String>,
    #[serde(rename = "keyboardEventsCount")]
    keyboard_events_count: i64,
    #[serde(rename = "mouseEventsCount")]
    mouse_events_count: i64,
    #[serde(rename = "sizeBytes")]
    size_bytes: i64,
}

pub fn spawn(db: SqlitePool, tokens: DeviceTokenStore, api_base: String) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let http = Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .expect("reqwest client");
        loop {
            match drain_one(&db, &tokens, &http, &api_base).await {
                Ok(true) => continue,           // uploaded one, immediately try the next
                Ok(false) => {                  // nothing to do
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
                Err(e) => {
                    tracing::warn!(err = %e, "upload worker error");
                    tokio::time::sleep(Duration::from_secs(10)).await;
                }
            }
        }
    })
}

async fn drain_one(
    db: &SqlitePool,
    tokens: &DeviceTokenStore,
    http: &Client,
    api_base: &str,
) -> Result<bool, String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let row = sqlx::query!(
        r#"SELECT id, time_entry_id, captured_at_ms, monitor_index, width, height,
                  bytes, size_bytes, active_app, active_window,
                  keyboard_count, mouse_count, attempts
           FROM outbox_screenshots
           WHERE uploaded_at IS NULL AND next_attempt_at <= ?1
           ORDER BY captured_at_ms ASC
           LIMIT 1"#,
        now_ms,
    )
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;

    let row = match row {
        Some(r) => r,
        None => return Ok(false),
    };

    let token = tokens.get().ok_or("no device token")?;
    let captured_at = chrono::DateTime::from_timestamp_millis(row.captured_at_ms)
        .ok_or("invalid captured_at_ms")?
        .to_rfc3339();
    let idem_key = format!("upload-{}", row.id);

    // 1. Presign
    let presign_url = format!("{}/api/v1/screenshots/presign", api_base);
    let presign: PresignResponse = http
        .post(&presign_url)
        .bearer_auth(&token)
        .header("Idempotency-Key", &idem_key)
        .json(&PresignBody {
            time_entry_id: &row.time_entry_id,
            captured_at: captured_at.clone(),
            monitor_index: row.monitor_index,
            content_type: "image/jpeg",
        })
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    // 2. PUT bytes to R2
    http.put(&presign.put_url)
        .header("Content-Type", "image/jpeg")
        .body(row.bytes.clone())
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;

    // 3. Confirm
    let confirm_url = format!("{}/api/v1/screenshots/{}/confirm", api_base, presign.screenshot_id);
    let confirm_body = ConfirmBody {
        width: row.width,
        height: row.height,
        active_app: row.active_app.clone(),
        active_window: row.active_window.clone(),
        keyboard_events_count: row.keyboard_count,
        mouse_events_count: row.mouse_count,
        size_bytes: row.size_bytes,
    };
    http.post(&confirm_url)
        .bearer_auth(&token)
        .header("Idempotency-Key", &idem_key)
        .json(&confirm_body)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;

    // 4. Mark uploaded
    sqlx::query!(
        "UPDATE outbox_screenshots
            SET uploaded_at = ?1, screenshot_id = ?2, last_error = NULL
          WHERE id = ?3",
        now_ms,
        presign.screenshot_id,
        row.id,
    )
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;

    Ok(true)
}

async fn schedule_retry(db: &SqlitePool, row_id: &str, attempts: i64, err: String) {
    let idx = attempts.min(BACKOFF_MS.len() as i64 - 1) as usize;
    let next_ms = chrono::Utc::now().timestamp_millis() + BACKOFF_MS[idx] as i64;
    let _ = sqlx::query!(
        "UPDATE outbox_screenshots
            SET attempts = attempts + 1,
                next_attempt_at = ?1,
                last_error = ?2
          WHERE id = ?3",
        next_ms,
        err,
        row_id,
    )
    .execute(db)
    .await;
}
```

Wire `schedule_retry` into the error paths above (presign / PUT / confirm) — every `?` that returns an error from `drain_one` should call `schedule_retry` before bubbling up. Skipped from the snippet to keep it readable; the actual implementation has one `if let Err(e) = ...` ladder.

### Backoff schedule

The constant array `BACKOFF_MS` matches [docs/07-screenshot-pipeline.md:34](../../docs/07-screenshot-pipeline.md#L34): 1m → 5m → 30m → 2h → 6h → 24h cap. After ~10 attempts (about 4 days of failure) the row is still in the queue, just retrying every 24h forever. We never drop. The UI should surface a banner once attempts > 5 — "uploads are failing, check your connection" — but the worker keeps going.

### Idempotency key

Each outbox row has a stable id (ULID). We send `Idempotency-Key: upload-<id>` on both presign and confirm. If the server already saw this key, it returns the same response — we won't double-create rows on retry.

### Why one upload at a time

Per [docs/07-screenshot-pipeline.md:33](../../docs/07-screenshot-pipeline.md#L33), we don't saturate the user's uplink. A 6-monitor capture every 10 minutes is ~3 MB/min upload bandwidth at most. We're not bottlenecked; we are _politeness-limited_.

## Bootstrap in `lib.rs`

```rust
.setup(|app| {
    let app_handle = app.handle().clone();
    let counters = activity::ActivityCounters::new();
    #[cfg(target_os = "macos")]
    activity::install_event_hooks(counters.clone());
    app.manage(counters.clone());

    let (state_tx, state_rx) = tokio::sync::watch::channel::<Option<scheduler::TrackingState>>(None);
    app.manage(state_tx);

    tauri::async_runtime::spawn(async move {
        let db = db::open_pool(&app_handle).await.expect("db open");
        let tokens = auth::DeviceTokenStore::load(&app_handle);
        let api_base = std::env::var("API_BASE_URL")
            .unwrap_or_else(|_| "http://localhost:3001".to_string());
        scheduler::spawn(db.clone(), counters, state_rx);
        uploader::spawn(db.clone(), tokens, api_base);
    });
    Ok(())
})
```

The `state_tx` is what the React UI flips when the user clicks Start / Stop, via a Tauri command:

```rust
#[tauri::command]
fn set_tracking(
    state: tauri::State<'_, tokio::sync::watch::Sender<Option<scheduler::TrackingState>>>,
    tracking: Option<scheduler::TrackingState>,
) -> Result<(), String> {
    state.send(tracking).map_err(|e| e.to_string())
}
```

## Files this plan adds

- `apps/desktop/src-tauri/migrations/001_outbox.sql`
- `apps/desktop/src-tauri/src/db.rs`
- `apps/desktop/src-tauri/src/scheduler.rs`
- `apps/desktop/src-tauri/src/uploader.rs`
- `apps/desktop/src-tauri/src/auth.rs` (the `DeviceTokenStore` referenced above — keychain wrapper)
- New commands: `set_tracking`, plus presign/confirm don't get JS-facing commands (the worker drives them).
- `Cargo.toml` deps: `rand`, `block2`, `libc` added on top of the scaffold list.

## What we are NOT building in this plan

- **Re-encoding bytes for retry:** if a confirm fails after a successful PUT, we just re-presign and re-PUT next time. Cheap, idempotent, no special-case code.
- **Reconciliation worker:** stuck rows are user-visible eventually (the UI shows pending count). A real reconciliation that asks the server "did this actually upload?" is Plan 09.
- **Disk-pressure handling:** if the DB grows past 1 GB ([docs/07-screenshot-pipeline.md:107](../../docs/07-screenshot-pipeline.md#L107)) we just keep going. A soft warning UI is Plan 09.
- **Deleting BLOBs after 24h** of `uploaded_at`: Plan 09 polish. We just leave them; the DB stays small enough on a working network.
