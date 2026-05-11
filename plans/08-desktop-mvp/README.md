# Plan 08 — Desktop MVP (Windows first)

> Roadmap milestone: **v0.5 Desktop app MVP, single OS** ([docs/10-roadmap.md:49-57](../../docs/10-roadmap.md#L49-L57)) — pivoted to Windows-first since the dev machine is Windows
> Priority bucket: **P1** (depends on Plans 02–05 server-side; web is not required to be feature-complete first)

## Goal

Ship a Windows-only Tauri 2 desktop app at `apps/desktop` that an authenticated user can install, log into, register as a device, pick a project, click Start, and have screenshots stream into the same backend the web app reads from. After this plan, the screenshot pipeline goes end-to-end from a real Windows machine → R2 → web admin grid (the grid itself is a future plan, but the rows it would query are landing).

This is the **single highest-risk plan** in the project. The risks have shrunk from the macOS-first draft because Windows skips two whole categories of pain (Screen Recording / Input Monitoring permission grants), but three independent unknowns remain:

1. **Tauri 2 + Rust toolchain on Windows** — first time we touch this stack on this OS.
2. **Low-level keyboard/mouse hooks via `SetWindowsHookEx`** — privacy-critical code that has to be reviewed strictly. Hooks need a dedicated thread with a Windows message loop.
3. **Screenshot capture via DXGI on multi-monitor / mixed-DPI setups** — modern Windows is messier than a single Mac display. We constrain to monitor 0 in this plan to bound it.

The plan deliberately scopes to **Windows 10 1809+ and Windows 11 only**. macOS lands as Plan 09 — most of the codebase is cross-platform Rust + React, so the Mac port is mostly:

- ~150 lines of `#[cfg(target_os = "macos")]` activity-counter code (NSEvent global monitors)
- Screen Recording / Input Monitoring permission detection + UI prompts
- macOS bundling + notarization

…on top of an already-shipping Windows app.

## Source-of-truth references

- Desktop architecture (Tauri shell, capture loop, outbox, idle, security): [docs/06-desktop-app.md](../../docs/06-desktop-app.md)
- Screenshot pipeline (capture → presign → R2 → confirm → process): [docs/07-screenshot-pipeline.md](../../docs/07-screenshot-pipeline.md)
- API endpoints the desktop consumes: [docs/05-api-surface.md:75-118](../../docs/05-api-surface.md#L75-L118)
- Auth model (device tokens, no expiry, OS keychain storage): [docs/08-auth-and-permissions.md:54-70](../../docs/08-auth-and-permissions.md#L54-L70)
- Privacy guardrails (what we capture, what we never store): [docs/09-privacy-and-ethics.md](../../docs/09-privacy-and-ethics.md)
- Tech stack (Tauri 2, React UI, Rust capture/idle crates): [docs/03-tech-stack.md:54-69](../../docs/03-tech-stack.md#L54-L69)
- Plans this builds on: [plans/05-screenshot-ingestion/](../05-screenshot-ingestion/) (server-side pipeline)

## Procurement (none required for v0.5)

The macOS-first draft front-loaded Apple Developer enrollment ($99/yr) as a calendar-time blocker. **For Windows-first, there is no procurement required for local dev or single-machine testing.**

- ❌ **Apple Developer cert** — not needed (no macOS build in this plan)
- ❌ **Windows EV cert ($300/yr)** — not needed for v0.5. Local installs and personal test machines work fine without it. SmartScreen will warn other users on first install, but right-click → "Run anyway" gets them past it. Only procure when v0.9 release-readiness needs the friction-free install experience for end users.
- ✅ **Tauri update signing keys** — generate via `pnpm tauri signer generate`. Store the private key in 1Password / a vault and back up to two places. **Losing it bricks future auto-updates** (when we wire them in Plan 09 / v0.9). Generating now is free and zero-effort; doing this in the wrong order later is irrecoverable.

## Pre-implementation verification (do these before building)

Three opens to confirm against the API code so we don't build a desktop client against drift:

1. **Does `POST /devices/register` return the device token plaintext exactly once and never again?** Per [docs/08-auth-and-permissions.md:55-59](../../docs/08-auth-and-permissions.md#L55-L59) this is the contract. Verify in [`apps/api/src/modules/devices/service.ts`](../../apps/api/src/modules/devices/service.ts) — confirm response shape `{ device, deviceId, deviceToken }` and no second-fetch endpoint exists.
2. **Does `POST /screenshots/presign` enforce the project's interval / blur settings, or does the desktop need to read them?** Verify in [`apps/api/src/modules/screenshots/service.ts`](../../apps/api/src/modules/screenshots/service.ts). The desktop needs `screenshotIntervalMinutes` to schedule captures locally — that comes from the project row, fetched once on Start.
3. **Does the API gracefully handle a `PATCH /time-entries/:id` for a `time_entry_id` the device made up?** Plan 05 implies the desktop creates time entries server-side first. Verify the local-temp-id path described in [docs/06-desktop-app.md:113-118](../../docs/06-desktop-app.md#L113-L118) — does the server require the canonical id, or accept a client-supplied id? If client-supplied isn't supported, we sequence creates strictly online-first in this plan and defer offline-create to Plan 09.

If gap #3 surfaces, the cleanest fix is to **make Start synchronous** in this plan — block the UI on `POST /time-entries` succeeding before allowing captures. Offline-create is real value but it's a Plan 09 concern.

## Decisions captured here (not implementation yet)

1. **Windows only.** `.msi` and `.nsis` installers via `tauri-build`. macOS ships in Plan 09. No Linux ever (per [docs/06-desktop-app.md:148](../../docs/06-desktop-app.md#L148)).
2. **Tauri 2.x pinned.** Tauri 1.x is sunset; 2.x has the plugin model we want for keychain (Credential Manager) + SQL. Pin major version in `Cargo.toml` and `package.json`.
3. **Rust capture via the `screenshots` crate** (per [docs/03-tech-stack.md:62](../../docs/03-tech-stack.md#L62)). On Windows it uses DXGI Desktop Duplication, which is the modern, GPU-friendly way. Multi-monitor capable — but we only capture monitor 0 in v0.5 to bound the test matrix.
4. **Idle detection via the `user-idle` crate.** On Windows it reads `GetLastInputInfo`. Polled every 5s. Cross-platform API, so the macOS port reuses the same code path. **Idle prompt UX is deferred to Plan 09** — this plan only records `totalIdleSeconds` correctly when the user comes back; no modal yet.
5. **Activity counters via low-level keyboard + mouse hooks.** `SetWindowsHookEx(WH_KEYBOARD_LL, ...)` and `WH_MOUSE_LL` from a dedicated worker thread that runs a Windows message loop. We **only increment counters** — never read virtual key codes, characters, mouse coordinates, or scroll deltas, per [docs/09-privacy-and-ethics.md](../../docs/09-privacy-and-ethics.md) and [docs/06-desktop-app.md:60-68](../../docs/06-desktop-app.md#L60-L68). This is the most privacy-sensitive code in the codebase — it gets a focused review.
6. **Local SQLite outbox via `sqlx` directly** (not `tauri-plugin-sql` for the worker code). Schema per [docs/06-desktop-app.md:81-103](../../docs/06-desktop-app.md#L81-L103). Stored at `%APPDATA%\app.hindsight.desktop\hindsight.db`.
7. **Upload worker is one Rust task with a single in-flight upload at a time.** Per [docs/07-screenshot-pipeline.md:33](../../docs/07-screenshot-pipeline.md#L33). Backoff: 1m → 5m → 30m → 2h → 6h → 24h cap, forever.
8. **Device token in Windows Credential Manager** via the `keyring` crate. The same Rust API works on Windows + macOS + Linux. **Never** in a config file or SQLite.
9. **No "refuse to run as admin" check in this plan.** The macOS draft refused to run as `root`; on Windows the equivalent ("refuse to run elevated") matters less because the install pattern is per-user (`%LOCALAPPDATA%\Programs\...`) and nothing in our app needs elevation. Revisit in Plan 09 if real-world usage shows users elevating for no reason.
10. **No auto-update in this plan** — that's a Plan 09 concern. Build artifacts are unsigned `.msi`s for personal testing.
11. **No idle-prompt modal in this plan** — deferred to Plan 09. We _track_ idle time; we don't yet _prompt_ on idle return.
12. **No multi-monitor in this plan** — capture monitor 0 only. Multi-monitor lands in Plan 09. Reduces test matrix.
13. **No "what this app records" first-run screen in this plan** — deferred to Plan 09. We do show a tray icon with a clear "TRACKING" state per [docs/06-desktop-app.md:136-138](../../docs/06-desktop-app.md#L136-L138) so consent isn't entirely absent.
14. **No Windows permission dialogs to navigate.** Unlike macOS, Windows doesn't gate screen capture or input hooks behind a per-app permission. The app starts capturing as soon as the user clicks Start — no grant ladder, no restart-after-grant. **This is the biggest reason Windows-first is faster than Mac-first.**
15. **JPEG quality 75, monitor 0 only.** Per [docs/07-screenshot-pipeline.md:25](../../docs/07-screenshot-pipeline.md#L25). One image per capture (no multi-monitor multiplication).
16. **Time-entry creation is online-only in this plan.** If the network is down when the user clicks Start, surface "couldn't start — check your connection". Offline-create lands in Plan 09 once we have the temp-id sync flow figured out.
17. **The desktop's React UI does NOT share routes with the web app.** Different shell entirely (Tauri window, no router). It reuses `@hindsight/shared/dto` and a few utility components copied from `apps/web/src/components/ui/`. Three screens total: Login, Picking, Tracking.
18. **Hook thread runs message loop, NOT the main thread.** Windows low-level hooks fire callbacks on the thread that called `SetWindowsHookEx` and require a `GetMessage`/`DispatchMessage` pump on that thread. We dedicate one OS thread to this. The thread is started during Tauri `setup` and runs for the app's lifetime.

## Out of scope for this plan (deferred to Plan 09 / later)

- **macOS build** — Plan 09 (v0.6)
- **Idle prompt UX** ("you were idle for X min — keep / discard / break") — Plan 09
- **Multi-monitor capture** — Plan 09
- **Auto-updater + Tauri updater manifest** — Plan 09 / v0.9
- **First-run "what this app records" screen** — Plan 09
- **EV code-signing cert + signed installer** — v0.9 release readiness
- **Capture flash overlay** — v0.8 polish per [docs/06-desktop-app.md:21](../../docs/06-desktop-app.md#L21)
- **Sentry crash reporting** — v0.9
- **Settings page in-app** (preferences, edit device name, etc.) — v0.8 polish
- **Offline-create time-entry flow** — Plan 09 (depends on verification #3 above)
- **Recent screenshots view in the app** — Plan 09; for v0.5 the user views their captures via the web app

## Files in this plan

- [scaffold.md](./scaffold.md) — Tauri 2 init, `Cargo.toml`, `tauri.conf.json`, package scripts, dev/build commands
- [capture.md](./capture.md) — Rust capture sidecar (the `screenshots` crate), JPEG encoding, the Windows raw-input hooks for activity counters
- [outbox.md](./outbox.md) — SQLite schema, sqlx pool, upload worker (presign → PUT → confirm → mark uploaded), exponential backoff
- [ui.md](./ui.md) — React UI inside the Tauri window: login, project picker, timer / tracking screen, tray icon
- [testing.md](./testing.md) — Rust unit tests for the outbox + scheduler; manual smoke runbook on a real Windows machine

## Ordered execution checklist

1. **Generate Tauri update signing keys** and back them up to two locations. Don't ship without this. Cost: 5 minutes. Lifelong consequence.
2. **Verify** the three open API questions above. Note any gaps in this README. If gap #3 (offline time-entry create) is real, the README's decision #16 holds and we ship online-only.
3. **Tauri scaffold.** `pnpm create tauri-app` adapted into `apps/desktop/`. React + Vite + TypeScript. Per [scaffold.md](./scaffold.md). End state: `pnpm --filter @hindsight/desktop tauri:dev` opens an empty Tauri window.
4. **Login screen.** First React screen. POSTs to `/auth/login`, stores the **web** token in app memory only. Calls `POST /devices/register` next, persists the **device** token in Windows Credential Manager via `keyring`. After registration the web token is discarded — desktop only ever uses the device token from here on.
5. **Org / project picker.** After login, fetch `/auth/me` to get memberships. Single org → auto-pick. Multi-org → simple `<select>`. Then fetch `/orgs/:orgId/projects` and render assigned projects. Show "Pick a project to start tracking."
6. **Capture sidecar.** Rust module behind a Tauri command `capture_screenshot()` that returns `{ bytes: Vec<u8>, width: u32, height: u32, captured_at: i64 }`. Uses the `screenshots` crate; encodes via `image` crate at JPEG quality 75. Per [capture.md](./capture.md).
7. **Activity counters.** Dedicated OS thread that calls `SetWindowsHookEx` for `WH_KEYBOARD_LL` and `WH_MOUSE_LL`, runs a `GetMessage` pump, and increments two `AtomicU64` counters from the hook procs. **Privacy-critical code — gets a separate review pass.**
8. **Idle detection.** `user-idle` crate polled every 5s. Configurable threshold (default 5 min). When tripped while tracking, set a `paused` flag — the active-time accumulator stops. When the user returns, accumulate the elapsed-while-idle seconds into `totalIdleSeconds`. **No modal in this plan** — that's Plan 09.
9. **Outbox + upload worker.** SQLite schema per [outbox.md](./outbox.md). One async Rust task pulls oldest pending row → presign → PUT → confirm → mark uploaded. Exponential backoff on every failure.
10. **Tracking screen UI.** Once a project is picked: big START button → POST `/time-entries`, returns `timeEntryId`. UI flips to "TRACKING" with project name, elapsed timer, current capture count. STOP button → PATCH `endedAt`, flush outbox if anything's pending, return to project picker.
11. **Tray icon.** Two states (idle / tracking). Right-click menu: Open, Stop, Quit. Tracking-state icon is a different colour so it's visible at a glance.
12. **`apps/desktop` build.** `pnpm --filter @hindsight/desktop tauri:build` produces an unsigned `.msi`. SmartScreen will warn on first install for users other than you; right-click → "Run anyway" works. Signed-cert wiring is Plan 09 / v0.9.
13. **Tests.** Rust unit tests for the outbox state machine and the backoff schedule. JS tests for any non-trivial UI utilities. Per [testing.md](./testing.md).
14. **Manual smoke test on your own Windows machine.** Per [testing.md](./testing.md). End-to-end: install the .msi → log in → register device → pick project → Start → wait one capture interval → stop → check the row appeared in the API DB and the JPEG appeared in R2.

## Done when

- A Windows user can install the dev `.msi`, log in with their Hindsight credentials, register a device, pick a project, click Start, and within `screenshotIntervalMinutes` see a screenshot row land in Postgres with `status = uploaded` (then `processed` after the API worker runs).
- The image in R2 matches what was on screen at capture time.
- Activity counts (`keyboardEventsCount`, `mouseEventsCount`) are non-zero on a capture preceded by typing/mouse use, and zero on a capture during pure idle.
- Stopping the time entry sends a PATCH that closes it server-side; the web admin can see the closed entry.
- Killing the network during tracking → captures keep happening locally → on reconnect, the outbox drains in order.
- Force-quitting the app mid-upload → on relaunch and login, the outbox resumes and uploads everything.
- Device token is in Windows Credential Manager, not in any plaintext file. Searching `%APPDATA%\app.hindsight.desktop\` for the token finds nothing.
- `pnpm --filter @hindsight/desktop typecheck` and the Rust `cargo check` (run by Tauri) both pass.
- The dev `.msi` installs cleanly on a clean Windows machine. SmartScreen warning on first install is expected and documented.
