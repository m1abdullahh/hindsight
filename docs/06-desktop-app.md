# 06 — Desktop App

## Goals

- Looks and feels native on Win/Mac.
- Tiny memory footprint (it runs all day).
- Survives offline gracefully — never loses screenshots.
- Updates itself silently.
- Makes it visually unmistakable when tracking is active.

## Shell: Tauri 2

- UI is React (shared component library with the web app where it makes sense).
- The Rust side handles screenshot capture, idle detection, tray icon, and the local SQLite queue.
- The webview is OS-native (WebView2 / WKWebView), so we're not shipping Chromium.

## Window structure

- **Main window** — login, project picker, current timer, recent screenshots (the user's own).
- **Tray icon** — always present when the app is running. Two states: idle, tracking. Right-click menu: Open, Pause, Stop, Quit.
- **Capture flash** (optional, opt-in per user) — a small unobtrusive overlay or sound on each capture, so the user is *visibly* reminded recording is happening.

## State machine

```
        ┌─────────┐
        │ LOGGED  │
        │   OUT   │
        └────┬────┘
             │ login → device register
             ▼
        ┌─────────┐
   ┌───►│  IDLE   │──── pick project + Start ────┐
   │    └────┬────┘                              ▼
   │         │ Quit                         ┌─────────┐
   │         ▼                              │ TRACKING│
   │    [exit]                              └────┬────┘
   │                                             │
   │           ┌──── system idle threshold ──────┤
   │           ▼                                 │
   │    ┌─────────────┐                          │
   │    │ IDLE-PROMPT │── decide: keep/discard ──┤
   │    └─────────────┘                          │
   │                                             │
   └────────────────── Stop ─────────────────────┘
```

## Capture loop

- Time entries divide into fixed **windows** of length `screenshotIntervalMinutes` (default 10).
- For each window, the app picks a uniformly random offset in `[15s, intervalSeconds - 15s]` — never at the very start or end (predictable).
- At that offset it:
  1. Captures all monitors (one image per monitor; we store each as a separate `Screenshot` row).
  2. Reads active window title + active app from the OS.
  3. Reads accumulated keyboard and mouse event counts since last capture, then resets the counters.
  4. JPEG-encodes (quality 75 by default — tunable).
  5. Inserts a row into the local SQLite `outbox` table with bytes + metadata.
- The capture loop never waits on the network. Uploading is decoupled.

## Activity counting

We hook OS-level input events but **only increment counters**. We never store key codes, characters, mouse positions, scroll amounts, or timing.

Per capture, we record:
- `keyboardEventsCount` — number of key-press events in the window
- `mouseEventsCount` — sum of clicks + significant moves (debounced)

That's it. This bounds the worst-case ethical and legal exposure.

## Idle detection

- Configurable threshold per project (default 5 minutes of no input).
- When threshold trips during tracking:
  - Pause the active-time accumulator.
  - On user return, show the IDLE-PROMPT modal: "You were idle for X min. **Keep**, **Discard**, or **Mark as break**."
  - Until they answer, the timer is paused but the time entry is still open.
- Idle time is recorded separately as `totalIdleSeconds`; admins see both.

## Local outbox (SQLite)

Schema:
```
outbox_screenshots(
  id TEXT PRIMARY KEY,
  time_entry_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  monitor_index INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  metadata_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  uploaded_at TEXT
)

outbox_time_entry_updates(
  id TEXT PRIMARY KEY,
  time_entry_id TEXT NOT NULL,
  patch_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  applied_at TEXT
)
```

Upload worker (in-app, background):
1. Fetch oldest non-uploaded row with `next_attempt_at <= now`.
2. `POST /screenshots/presign`.
3. PUT bytes to R2.
4. `POST /screenshots/:id/confirm`.
5. Mark `uploaded_at`, schedule a delete sweep that drops the BLOB after 24h (keep the row briefly for debugging).
6. On failure: exponential backoff (1m, 5m, 30m, 2h, 6h, 24h cap). After ~10 attempts spanning a few days, surface a UI warning "uploads are failing" but keep retrying forever — never drop screenshots.

## Time entry sync

The desktop drives time entry creation. On Start:
1. App calls `POST /time-entries`. If offline, it creates a local row with a temp ID and queues the create.
2. Subsequent `PATCH`es accumulate locally and replay.
3. Screenshots reference the local time entry ID; on first successful sync, server returns the canonical ID and we rewrite outbox rows.

## Auto-update

- Tauri updater pointed at a GitHub Releases-backed JSON manifest.
- Signed with our update key (do **not** lose this — losing it bricks updates).
- Check on startup and every 6 hours.
- If an update is downloaded, prompt the user; install on next quit unless they accept now.
- Force-update floor: server can refuse to talk to versions older than `minSupportedVersion`; client shows "please update" and links to download.

## Security

- Device tokens are stored in OS keychain (Keychain on Mac, Credential Manager on Win) via `tauri-plugin-stronghold` or platform-specific shims — **never** in plain config files.
- Screenshots in the outbox are written to a per-user app-data directory with restrictive permissions.
- The app refuses to run as root/Administrator (defense against accidental privilege escalation).
- Crash reports are scrubbed of file paths and active window titles before sending to Sentry.

## Visibility / consent

- App icon always visible in the tray while running.
- A persistent in-window banner says "TRACKING" with the current project name and a Stop button while a time entry is active.
- First run flow shows a screen titled "What this app records" with an explicit list and a button labeled "I understand". This screen is also reachable any time from settings.

## Build matrix

| OS | Architectures | Installer |
|---|---|---|
| Windows 10/11 | x64, arm64 | `.msi` (signed) |
| macOS 12+ | x64, arm64 (universal) | `.dmg` (signed + notarized) |

Linux is not a target for v1.
