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
  screenshot_id   TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  uploaded_at     INTEGER,
  last_error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox_screenshots (uploaded_at, next_attempt_at);

CREATE TABLE IF NOT EXISTS outbox_time_entries (
  id              TEXT PRIMARY KEY,
  patch_json      TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  applied_at      INTEGER
);

CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
