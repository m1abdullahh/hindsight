// Outbox cleanup. Once a screenshot has been uploaded successfully, the
// captured bytes serve no purpose locally — but the row stays around for a
// short audit window so a user (or support session) can inspect the recent
// upload trail. After that window passes the BLOB is zero'd to reclaim
// disk; after a longer window the entire row goes away.
//
// Without this, every screenshot the user ever captured stays on disk
// forever and ends up in their iCloud / OneDrive / Time Machine backup,
// quietly defeating the server-side retention promise in
// 09-privacy-and-ethics.md §"Retention is finite."

use std::time::Duration;

use sqlx::SqlitePool;

const SWEEP_INTERVAL_SECS: u64 = 60 * 60; // hourly
const BLOB_RETENTION_MS: i64 = 24 * 60 * 60 * 1000; // 24h
const ROW_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000; // 7d

pub fn spawn(db: SqlitePool) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            // Run once at startup, then every interval. Late starts catch
            // up at most one batch each — sweep is set-based, not per-row.
            match sweep_once(&db).await {
                Ok((zeroed, deleted)) if zeroed > 0 || deleted > 0 => {
                    tracing::info!(zeroed, deleted, "outbox sweep");
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(err = %e, "outbox sweep failed"),
            }
            tokio::time::sleep(Duration::from_secs(SWEEP_INTERVAL_SECS)).await;
        }
    })
}

async fn sweep_once(db: &SqlitePool) -> Result<(u64, u64), sqlx::Error> {
    let now_ms = chrono::Utc::now().timestamp_millis();

    // Zero the BLOB on rows uploaded > 24h ago that still carry bytes. The
    // `length(bytes) > 0` guard makes this a no-op on already-swept rows so
    // re-running the sweep doesn't churn through a VACUUM-worth of writes.
    let blob_cutoff = now_ms - BLOB_RETENTION_MS;
    let zeroed = sqlx::query(
        "UPDATE outbox_screenshots
            SET bytes = x'', size_bytes = 0
          WHERE uploaded_at IS NOT NULL
            AND uploaded_at < ?1
            AND length(bytes) > 0",
    )
    .bind(blob_cutoff)
    .execute(db)
    .await?
    .rows_affected();

    // Delete the row entirely after a longer window. By this point the
    // server has acknowledged the upload and the local copy has been
    // empty for days — nothing to lose.
    let row_cutoff = now_ms - ROW_RETENTION_MS;
    let deleted = sqlx::query(
        "DELETE FROM outbox_screenshots
          WHERE uploaded_at IS NOT NULL
            AND uploaded_at < ?1",
    )
    .bind(row_cutoff)
    .execute(db)
    .await?
    .rows_affected();

    Ok((zeroed, deleted))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn make_pool() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect(":memory:")
            .await
            .unwrap();
        sqlx::query(include_str!("../migrations/001_outbox.sql"))
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    async fn insert_uploaded(
        pool: &SqlitePool,
        id: &str,
        uploaded_at_ms: i64,
        bytes_len: usize,
    ) {
        sqlx::query(
            "INSERT INTO outbox_screenshots
              (id, time_entry_id, captured_at_ms, monitor_index, width, height,
               bytes, size_bytes, uploaded_at)
             VALUES (?1, 't', 0, 0, 1, 1, ?2, ?3, ?4)",
        )
        .bind(id)
        .bind(vec![0u8; bytes_len])
        .bind(bytes_len as i64)
        .bind(uploaded_at_ms)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn sweep_zeros_old_blobs_but_keeps_row() {
        let pool = make_pool().await;
        let old = chrono::Utc::now().timestamp_millis() - 25 * 60 * 60 * 1000; // 25h ago
        insert_uploaded(&pool, "old", old, 1024).await;

        let (zeroed, deleted) = sweep_once(&pool).await.unwrap();
        assert_eq!(zeroed, 1);
        assert_eq!(deleted, 0);

        let row: (Vec<u8>, i64) = sqlx::query_as(
            "SELECT bytes, size_bytes FROM outbox_screenshots WHERE id = 'old'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(row.0.is_empty());
        assert_eq!(row.1, 0);
    }

    #[tokio::test]
    async fn sweep_deletes_rows_past_one_week() {
        let pool = make_pool().await;
        let week_old = chrono::Utc::now().timestamp_millis() - 8 * 24 * 60 * 60 * 1000;
        insert_uploaded(&pool, "ancient", week_old, 16).await;

        let (_, deleted) = sweep_once(&pool).await.unwrap();
        assert_eq!(deleted, 1);

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbox_screenshots")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn sweep_is_idempotent_on_already_zeroed_rows() {
        let pool = make_pool().await;
        let recent_zero = chrono::Utc::now().timestamp_millis() - 25 * 60 * 60 * 1000;
        insert_uploaded(&pool, "z", recent_zero, 0).await;

        let (zeroed, _) = sweep_once(&pool).await.unwrap();
        // No bytes to clear — should not count as a zero.
        assert_eq!(zeroed, 0);
    }
}
