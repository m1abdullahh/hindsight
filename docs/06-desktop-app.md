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

- **Main window** — login, project picker, current timer, "My time" panel (per-project totals for the signed-in user).
- **Tray icon** — always present when the app is running. Two states: idle, tracking. Right-click menu: Open, Stop, Quit.
- **Capture notification** — a native OS toast titled "Hindsight / Screenshot captured" fires on every successful capture. This replaces the earlier "capture flash overlay" idea — the OS toast is unmistakable, consistent across both OSes, and doesn't require an always-on transparent overlay window.

### "My time" panel

A compact widget on the project-picker screen showing the signed-in user's
tracked time per project. Source: `GET /orgs/:orgId/reports/time-totals` with
no `userId` filter (the API auto-scopes members to themselves).

- Toggle: **Today / Week / All** (default: Today).
- Per row: project name + duration + earned $ (when the project's assignment
  has an `hourlyRateCents` set).
- One total line when more than one project is listed.
- Lives in `apps/desktop/src/components/MyTimePanel.tsx`.

### Today's-baseline tracker timer

By design choice, the on-screen timer **does not reset to 00:00 on every Start**
when the user has already tracked time on the picked project today. Instead:

1. On Start, the desktop calls `GET /orgs/:orgId/reports/time-totals?projectId=…&from=<startOfToday>`
   and saves the returned `totalActiveSeconds` as `baselineTodaySeconds` in
   the session store.
2. The TrackingScreen renders `formatElapsed(baselineTodaySeconds + sessionElapsed)`.
3. On Stop, `baselineTodaySeconds` is cleared. The next session re-queries.

This keeps the on-screen timer aligned with "how much have I worked on this
project today" while keeping `TimeEntry.totalActiveSeconds` clean (each row
only carries its own session's duration; the API aggregates).

The query runs once at Start; we do not re-fetch during the session because
multi-device parallel tracking would lead to flicker. If a second device
starts tracking the same project concurrently, the on-screen total is
"my view at session start"; the report data on the web will still aggregate
correctly across both.

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

### totalActiveSeconds flush cadence

While tracking is active, the React TrackingScreen pushes elapsed seconds to
the server every 60 seconds:

```ts
useEffect(() => {
  if (!timeEntryId || !startedAt) return;
  const start = new Date(startedAt).getTime();
  const id = window.setInterval(() => {
    const elapsed = Math.min(86_400, Math.floor((Date.now() - start) / 1000));
    void apiPatch(
      `/time-entries/${timeEntryId}`,
      { totalActiveSeconds: elapsed },
      crypto.randomUUID(),
    ).catch(() => {});
  }, 60_000);
  return () => window.clearInterval(id);
}, [timeEntryId, startedAt]);
```

Failures are swallowed; the final authoritative value goes out at Stop along
with `endedAt`. Without this loop, the web report would show 0 for any
in-progress session until the user clicked Stop.

### Capture notifications (Windows AUMID)

The Rust scheduler calls
`app.notification().builder().title("Hindsight").body("Screenshot captured").show()`
after each persisted capture (see `apps/desktop/src-tauri/src/scheduler.rs`).

Windows attributes toast notifications to the **AppUserModelID (AUMID)** of
the launching process unless the app sets its own. To avoid the toast being
labelled "Windows PowerShell" (in `tauri dev`) or "cmd" (when launched from
a shell), the app registers its AUMID at startup:

1. `SetCurrentProcessExplicitAppUserModelID("app.hindsight.desktop")` —
   tells Windows what identity to use for this process's notifications.
2. Writes `HKCU\Software\Classes\AppUserModelId\app.hindsight.desktop` with
   `DisplayName = "Hindsight"` and `IconUri` pointing at `icons/icon.ico`.

Both steps live in `apps/desktop/src-tauri/src/win_aumid.rs`. They are
idempotent and HKCU-scoped — no admin required. In a production
installer-launched app the Start Menu shortcut already carries the AUMID,
but the runtime registration is harmless and protects dev workflows.

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

| OS            | Architectures          | Installer                   |
| ------------- | ---------------------- | --------------------------- |
| Windows 10/11 | x64, arm64             | `.msi` (signed)             |
| macOS 12+     | x64, arm64 (universal) | `.dmg` (signed + notarized) |

Linux is not a target for v1.
