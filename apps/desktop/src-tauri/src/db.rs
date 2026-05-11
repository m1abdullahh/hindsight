use std::path::PathBuf;
use std::str::FromStr;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use tauri::Manager;

pub async fn open_pool(app: &tauri::AppHandle) -> Result<SqlitePool, sqlx::Error> {
    let dir = app
        .path()
        .app_data_dir()
        .expect("app_data_dir resolvable");
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

    apply_migrations(&pool).await?;
    Ok(pool)
}

async fn apply_migrations(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    // Inline the migration so the binary doesn't depend on the migrations
    // directory at runtime. Add subsequent migrations here as new const &str.
    const M001: &str = include_str!("../migrations/001_outbox.sql");

    sqlx::query(M001).execute(pool).await?;
    Ok(())
}
