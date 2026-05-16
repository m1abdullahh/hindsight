use std::sync::Arc;
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};

use crate::auth::DeviceTokenStore;
use crate::scheduler::emit_outbox_changed;

const BACKOFF_MS: &[u64] = &[
    60_000,        // 1 min
    300_000,       // 5 min
    1_800_000,     // 30 min
    7_200_000,     // 2 hr
    21_600_000,    // 6 hr
    86_400_000,    // 24 hr cap
];

#[derive(Debug, thiserror::Error)]
pub enum UploadError {
    #[error("no device token")]
    NoToken,
    #[error("invalid timestamp: {0}")]
    BadTimestamp(i64),
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("SQL error: {0}")]
    Sql(#[from] sqlx::Error),
    // API errors are from the Hindsight server — a 401/403 here means our
    // bearer token is dead. Treated as auth failure by the loop.
    #[error("api: {status} {body}")]
    Api { status: u16, body: String },
    // R2 errors are from the presigned PUT step. Even 401/403 here have
    // nothing to do with our bearer token (presigned URL signs itself).
    #[error("r2 put: {status} {body}")]
    R2Put { status: u16, body: String },
}

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
    captured_at: String,
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
    active_window_title: Option<String>,
    #[serde(rename = "keyboardEventsCount")]
    keyboard_events_count: i64,
    #[serde(rename = "mouseEventsCount")]
    mouse_events_count: i64,
    #[serde(rename = "sizeBytes")]
    size_bytes: i64,
}

pub fn spawn(
    app: AppHandle,
    db: SqlitePool,
    tokens: Arc<DeviceTokenStore>,
    api_base: String,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let http = match Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(err = %e, "failed to build reqwest client; uploader exiting");
                return;
            }
        };

        loop {
            match drain_one(&db, &tokens, &http, &api_base).await {
                Ok(true) => {
                    emit_outbox_changed(&app, &db).await;
                    continue; // immediately try the next row
                }
                Ok(false) => {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
                Err(e) => {
                    // Treat 401/403 from the API as a server-side
                    // revocation: clear the local token so the next loop
                    // iteration short-circuits on NoToken instead of
                    // burning retries against a dead credential, and tell
                    // the UI to prompt re-auth so the user actually sees
                    // why captures have stopped uploading.
                    if is_auth_failure(&e) {
                        tracing::warn!(err = %e, "upload auth failure; clearing token");
                        let _ = tokens.clear();
                        let _ = app.emit(
                            "reauth-required",
                            serde_json::json!({ "reason": e.to_string() }),
                        );
                        emit_outbox_changed(&app, &db).await;
                    } else {
                        tracing::warn!(err = %e, "upload tick error");
                    }
                    tokio::time::sleep(Duration::from_secs(10)).await;
                }
            }
        }
    })
}

// Auth failures originate at the API only (presign/confirm), not at the R2
// PUT step — R2 uses the presigned URL's own signature and doesn't see our
// bearer token. A 401/403 here means the token is dead from the server's
// perspective (admin revoked, user signed out elsewhere, password reset
// nuked it). Retrying with the same token is pointless until the user
// signs in again.
fn is_auth_failure(err: &UploadError) -> bool {
    matches!(err, UploadError::Api { status: 401 | 403, .. })
}

#[derive(sqlx::FromRow)]
struct PendingRow {
    id: String,
    time_entry_id: String,
    captured_at_ms: i64,
    monitor_index: i64,
    width: i64,
    height: i64,
    bytes: Vec<u8>,
    size_bytes: i64,
    active_app: Option<String>,
    active_window: Option<String>,
    keyboard_count: i64,
    mouse_count: i64,
    attempts: i64,
}

async fn drain_one(
    db: &SqlitePool,
    tokens: &DeviceTokenStore,
    http: &Client,
    api_base: &str,
) -> Result<bool, UploadError> {
    let now_ms = chrono::Utc::now().timestamp_millis();

    let row: Option<PendingRow> = sqlx::query_as(
        "SELECT id, time_entry_id, captured_at_ms, monitor_index, width, height,
                bytes, size_bytes, active_app, active_window,
                keyboard_count, mouse_count, attempts
         FROM outbox_screenshots
         WHERE uploaded_at IS NULL AND next_attempt_at <= ?1
         ORDER BY captured_at_ms ASC
         LIMIT 1",
    )
    .bind(now_ms)
    .fetch_optional(db)
    .await?;

    let Some(row) = row else { return Ok(false); };

    match upload_one(db, tokens, http, api_base, &row).await {
        Ok(_) => Ok(true),
        Err(e) => {
            schedule_retry(db, &row.id, row.attempts, e.to_string()).await;
            Err(e)
        }
    }
}

async fn upload_one(
    db: &SqlitePool,
    tokens: &DeviceTokenStore,
    http: &Client,
    api_base: &str,
    row: &PendingRow,
) -> Result<(), UploadError> {
    let token = tokens.get().ok_or(UploadError::NoToken)?;
    // Format with explicit `Z` literal — Zod's `.datetime()` rejects `+00:00`
    // in default-strict mode. The format string is hand-written to avoid any
    // chrono-version surprises with `to_rfc3339_opts`.
    let dt = chrono::DateTime::from_timestamp_millis(row.captured_at_ms)
        .ok_or(UploadError::BadTimestamp(row.captured_at_ms))?;
    let captured_at = dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    tracing::debug!(captured_at = %captured_at, row_id = %row.id, "presigning");
    let idem_key = format!("upload-{}", row.id);

    // 1. Presign
    let presign_url = format!("{}/api/v1/screenshots/presign", api_base);
    let presign_res = http
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
        .await?;
    let presign: PresignResponse = parse_or_err(presign_res).await?;

    // 2. PUT bytes to R2
    let put_res = http
        .put(&presign.put_url)
        .header("Content-Type", "image/jpeg")
        .body(row.bytes.clone())
        .send()
        .await?;
    if !put_res.status().is_success() {
        let status = put_res.status().as_u16();
        let body = put_res.text().await.unwrap_or_default();
        return Err(UploadError::R2Put { status, body });
    }

    // 3. Confirm
    let confirm_url = format!(
        "{}/api/v1/screenshots/{}/confirm",
        api_base, presign.screenshot_id
    );
    let confirm_res = http
        .post(&confirm_url)
        .bearer_auth(&token)
        .header("Idempotency-Key", &idem_key)
        .json(&ConfirmBody {
            width: row.width,
            height: row.height,
            active_app: row.active_app.clone(),
            active_window_title: row.active_window.clone(),
            keyboard_events_count: row.keyboard_count,
            mouse_events_count: row.mouse_count,
            size_bytes: row.size_bytes,
        })
        .send()
        .await?;
    if !confirm_res.status().is_success() {
        let status = confirm_res.status().as_u16();
        let body = confirm_res.text().await.unwrap_or_default();
        return Err(UploadError::Api { status, body });
    }

    // 4. Mark uploaded
    let now_ms = chrono::Utc::now().timestamp_millis();
    sqlx::query(
        "UPDATE outbox_screenshots
            SET uploaded_at = ?1, screenshot_id = ?2, last_error = NULL
          WHERE id = ?3",
    )
    .bind(now_ms)
    .bind(&presign.screenshot_id)
    .bind(&row.id)
    .execute(db)
    .await?;

    Ok(())
}

async fn parse_or_err<T: for<'de> Deserialize<'de>>(
    res: reqwest::Response,
) -> Result<T, UploadError> {
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        return Err(UploadError::Api { status, body });
    }
    let v = res.json::<T>().await?;
    Ok(v)
}

async fn schedule_retry(db: &SqlitePool, row_id: &str, attempts: i64, err: String) {
    let idx = attempts.min(BACKOFF_MS.len() as i64 - 1) as usize;
    let next_ms = chrono::Utc::now().timestamp_millis() + BACKOFF_MS[idx] as i64;
    let truncated_err = err.chars().take(500).collect::<String>();
    let _ = sqlx::query(
        "UPDATE outbox_screenshots
            SET attempts = attempts + 1,
                next_attempt_at = ?1,
                last_error = ?2
          WHERE id = ?3",
    )
    .bind(next_ms)
    .bind(&truncated_err)
    .bind(row_id)
    .execute(db)
    .await;
}

#[cfg(test)]
mod tests {
    use super::{is_auth_failure, UploadError, BACKOFF_MS};

    #[test]
    fn backoff_schedule_is_monotonic_and_capped() {
        for i in 0..(BACKOFF_MS.len() - 1) {
            assert!(BACKOFF_MS[i] < BACKOFF_MS[i + 1], "monotonic at {}", i);
        }
        assert_eq!(*BACKOFF_MS.last().unwrap(), 86_400_000);
    }

    #[test]
    fn backoff_index_clamps_to_last() {
        let attempts: i64 = 100;
        let idx = (attempts.min(BACKOFF_MS.len() as i64 - 1)) as usize;
        assert_eq!(idx, BACKOFF_MS.len() - 1);
    }

    #[test]
    fn auth_failure_detects_api_401_and_403() {
        assert!(is_auth_failure(&UploadError::Api {
            status: 401,
            body: String::new()
        }));
        assert!(is_auth_failure(&UploadError::Api {
            status: 403,
            body: String::new()
        }));
    }

    #[test]
    fn auth_failure_ignores_other_api_statuses_and_r2_errors() {
        // R2 errors are never our bearer token's fault.
        assert!(!is_auth_failure(&UploadError::R2Put {
            status: 401,
            body: String::new()
        }));
        assert!(!is_auth_failure(&UploadError::R2Put {
            status: 403,
            body: String::new()
        }));
        // 5xx from the API isn't auth — keep retrying.
        assert!(!is_auth_failure(&UploadError::Api {
            status: 500,
            body: String::new()
        }));
        // Other API 4xx (e.g. 415 mismatch from /confirm) isn't auth either.
        assert!(!is_auth_failure(&UploadError::Api {
            status: 415,
            body: String::new()
        }));
    }
}
