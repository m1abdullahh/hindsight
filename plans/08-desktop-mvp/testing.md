# Desktop MVP — Testing

The desktop has more failure modes than the web client (filesystem, native crates, Tauri bridge), but **only** Windows in scope, so the test matrix is bounded.

Three layers of testing:

1. **Rust unit tests** for the outbox state machine, scheduler offset logic, activity counters, and backoff schedule.
2. **JS unit tests** for any non-trivial UI utilities (date formatting). Keep this very small.
3. **Manual smoke test on a real Windows machine** — the only way to actually validate capture, hooks, Credential Manager, and tray.

We don't write end-to-end tests with a mocked OS. The hard parts (DXGI capture, low-level hooks, Credential Manager) can't be meaningfully mocked, and the parts that can be mocked are thin glue. Energy spent on E2E mock-ware would be better spent on the smoke runbook.

## Rust unit tests

`apps/desktop/src-tauri/src/scheduler.rs` — at the bottom:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_offset_respects_min_and_max() {
        // Repeated draws on a 10-minute window should always be in [15, 585].
        let interval_secs: u64 = 10 * 60;
        for _ in 0..1000 {
            let mut rng = rand::thread_rng();
            let offset = rng.gen_range(15u64..interval_secs.saturating_sub(15));
            assert!(offset >= 15);
            assert!(offset <= interval_secs - 15);
        }
    }

    #[test]
    fn very_short_interval_falls_back_to_safe_min() {
        // A 30-second interval can't accommodate a 15-second margin both sides.
        // The .max(16) clause keeps the rng range non-empty.
        let interval_secs: u64 = 30;
        let mut rng = rand::thread_rng();
        let offset = rng.gen_range(15u64..interval_secs.saturating_sub(15).max(16));
        assert!(offset >= 15);
    }
}
```

`apps/desktop/src-tauri/src/uploader.rs` — backoff schedule:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_schedule_is_monotonic_and_capped() {
        for i in 0..(BACKOFF_MS.len() - 1) {
            assert!(BACKOFF_MS[i] < BACKOFF_MS[i + 1], "monotonic at {}", i);
        }
        assert_eq!(*BACKOFF_MS.last().unwrap(), 86_400_000); // 24h cap
    }

    #[test]
    fn backoff_index_clamps_to_last() {
        let attempts: i64 = 100;
        let idx = (attempts.min(BACKOFF_MS.len() as i64 - 1)) as usize;
        assert_eq!(idx, BACKOFF_MS.len() - 1);
    }
}
```

`apps/desktop/src-tauri/src/activity.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_and_reset_zeroes_counters() {
        let c = ActivityCounters::new();
        c.bump_keyboard();
        c.bump_keyboard();
        c.bump_mouse();
        let (kb, ms) = c.read_and_reset();
        assert_eq!(kb, 2);
        assert_eq!(ms, 1);
        let (kb2, ms2) = c.read_and_reset();
        assert_eq!(kb2, 0);
        assert_eq!(ms2, 0);
    }

    #[test]
    fn counters_are_thread_safe() {
        use std::sync::Arc;
        use std::thread;
        let c = ActivityCounters::new();
        let mut handles = Vec::new();
        for _ in 0..8 {
            let c = c.clone();
            handles.push(thread::spawn(move || {
                for _ in 0..1000 {
                    c.bump_keyboard();
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let (kb, _) = c.read_and_reset();
        assert_eq!(kb, 8000);
    }
}
```

The hook procs themselves are not unit-testable in any standard way — they require a real OS message pump. Smoke test catches misbehaviour.

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`.

## JS unit tests

Almost nothing JS-side has interesting logic. The `formatElapsed` helper in `TrackingScreen` is one exception:

`apps/desktop/src/screens/__tests__/format-elapsed.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { formatElapsed } from '../format-elapsed';

describe('formatElapsed', () => {
  it('formats 0 seconds', () => {
    expect(formatElapsed(0)).toBe('00:00:00');
  });
  it('formats minutes', () => {
    expect(formatElapsed(75)).toBe('00:01:15');
  });
  it('formats hours', () => {
    expect(formatElapsed(3725)).toBe('01:02:05');
  });
  it('handles many hours', () => {
    expect(formatElapsed(36000)).toBe('10:00:00');
  });
});
```

(Extract the helper out of `TrackingScreen.tsx` into its own file once the test exists. Keeps the screen file pure presentation.)

## Manual smoke runbook on a real Windows machine

This is the _primary_ validation. Run before claiming Plan 08 done.

### Prereqs

- Windows 10 1809+ or Windows 11
- A user account (admin rights NOT needed; the app installs per-user)
- Rust + MSVC build tools installed (per [scaffold.md](./scaffold.md#prerequisites-on-the-dev-machine))
- The API and DB running (`pnpm --filter @hindsight/api dev` against your Neon dev branch)
- A test user account in the web app with at least one assigned project
- Web app running (`pnpm --filter @hindsight/web dev`) so you can verify rows appear

### Build the dev installer

```sh
pnpm --filter @hindsight/desktop tauri:build
```

Produces:

- `apps/desktop/src-tauri/target/release/bundle/msi/Hindsight_0.1.0_x64_en-US.msi` (Wix)
- `apps/desktop/src-tauri/target/release/bundle/nsis/Hindsight_0.1.0_x64-setup.exe` (NSIS)

Either is fine for testing. NSIS is a smaller download.

### Install + first run

1. Double-click the `.msi` (or `.exe`). SmartScreen will probably warn "Windows protected your PC" — that's expected for an unsigned build. Click **More info** → **Run anyway**.
2. Installer runs, Hindsight installs to `%LOCALAPPDATA%\Programs\Hindsight\`. No UAC prompt (per-user install).
3. Launch Hindsight from the Start menu.
4. App opens to the **Login** screen.
5. Log in with your test account. Watch the API console for the `POST /auth/login` and `POST /devices/register` requests — both should return 200/201.
6. The picker screen appears with your assigned projects.

### Tracking flow

7. Pick a project from the dropdown.
8. Click **Start tracking** → UI flips to TRACKING screen with a red banner "● TRACKING", the project name, and an elapsed timer ticking up.
9. Tray icon (in the system tray, by the clock) switches to the tracking variant.
10. Wait for one capture interval. Use the keyboard and move the mouse during the wait. After ~5–9 minutes (random offset on a 10-min interval), a capture fires. Watch the API console — you'll see `POST /screenshots/presign` followed by `POST /screenshots/:id/confirm`.
11. Check the API DB:
    ```sql
    select id, status, keyboard_events_count, mouse_events_count, captured_at
    from screenshots order by created_at desc limit 1;
    ```
    The row should be `status = 'uploaded'` (briefly), then `'processed'` after the API worker runs. Counts should be > 0.
12. In the Cloudflare R2 dashboard, navigate to your bucket → confirm the `.jpg` is there at the path `orgs/<orgId>/users/<userId>/<yyyy>/<mm>/<dd>/<screenshotId>.jpg`. Open it — it should be a screenshot of your desktop at capture time.

### Offline resilience

13. Disable your internet (Wi-Fi off, or unplug Ethernet).
14. Wait for one more capture interval. The capture lands in the local outbox; the upload worker fails with a network error and schedules a retry.
15. Re-enable internet. The next worker tick uploads the queued capture. Verify the row appears in Postgres.
16. Quit the app mid-tracking with captures in the outbox (`%APPDATA%\app.hindsight.desktop\hindsight.db` exists). Relaunch the app — log in if needed; the outbox should drain on next worker tick.

### Stop + cleanup

17. Click **Stop** on the tracking screen. UI returns to picking. The API console shows `PATCH /time-entries/<id>` with `endedAt`.
18. Open the web app's time-entries view (or query the DB) — the entry should be closed with non-null `endedAt` and reasonable `totalActiveSeconds`.
19. Sign out from the picker → returns to login. The Credential Manager entry for "app.hindsight.desktop" / "device_token" should be gone (check via `cmdkey /list` or Control Panel → Credential Manager → Windows Credentials).

### Privacy / security checks

20. **Token never written to disk in plaintext.** Open `%APPDATA%\app.hindsight.desktop\` — the only file should be `hindsight.db` (SQLite) plus maybe a log. Run a string search:
    ```powershell
    Select-String -Path "$env:APPDATA\app.hindsight.desktop\*" -Pattern "<a-substring-of-the-token>"
    ```
    Should find nothing. The token lives in Credential Manager only.
21. **Hook code doesn't read keystrokes.** Read `apps/desktop/src-tauri/src/activity.rs` — confirm there's no dereference of the `KBDLLHOOKSTRUCT` or `MSLLHOOKSTRUCT` pointers. Only `wParam` is read.
22. **Logs never contain key codes / characters / mouse coordinates / window titles.** Check the app's debug logs (set `RUST_LOG=hindsight_lib=debug` and tail stdout) during a tracking session — no event-payload data should appear.

### Crash + recovery

23. While tracking, force-kill the app via Task Manager.
24. Relaunch. The picker screen should appear (token still in Credential Manager). Pending uploads from the dead session, if any, drain shortly after relaunch.
25. The unfinished time entry stays open server-side. Closing it cleanly is a Plan 09 concern — for v0.5, you patch it manually via the web app or a curl. Document this in the README's known-gaps if needed.

### Anti-cheat / protected-process gotcha

26. **Known limitation:** when a kernel-mode-protected app has focus (Valorant, certain banking apps, Easy Anti-Cheat), low-level hooks return zero events for that focus duration. Captures still fire and screenshots upload, but `keyboardEventsCount` and `mouseEventsCount` will be 0 for that window. This is normal and expected on Windows. Document in the user-facing FAQ.

### Deliverables checklist

If all 26 steps pass, Plan 08 is shipped. File the issues from any failures into Plan 09's TODO. Common ones to expect:

- Tray icon doesn't update on stage change (event listener race) → Plan 09
- Idle return from sleep wakes the app but the timer kept counting → Plan 09 idle handling
- A capture during the first second of a relaunch may have empty activity counts (hooks not yet installed) → known minor; Plan 09

## CI

We do **not** run the full smoke runbook in CI. We do run:

- `pnpm -r typecheck` (TypeScript across all packages)
- `pnpm -r test` (Vitest unit tests in api/web/desktop)
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` (Rust unit tests, on a Windows runner)
- `pnpm --filter @hindsight/desktop build:vite` (the Vite build, no Tauri bundling — keeps CI fast)

Tauri's full `tauri:build` step (the .msi linker pass) is too slow for every PR. Run it on tag pushes for release builds only — that wiring is Plan 09.

## What we explicitly don't test automatically

- Real screen capture (no GPU / display in CI runners)
- Low-level hook behavior (humans-only — needs a real interactive desktop)
- Tray icon behavior
- Credential Manager access (CI runners may have one but writing/reading there in tests adds environment fragility)

These are all caught by the manual smoke runbook on a real Windows machine. The cost-benefit of mocking them in tests is poor — we'd write 1000 lines of mock infrastructure to catch issues a 20-minute smoke run already catches.
