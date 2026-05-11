# Plan 10 — Desktop: Capture Notifications & Windows AUMID

> Roadmap milestone: **v0.8 Polish** ([docs/10-roadmap.md](../../docs/10-roadmap.md)) — replaces the original "capture flash overlay" bullet.
> Priority bucket: **P2** (visibility / consent feature, ships alongside Plan 08)

## Goal

Make every screenshot capture unmistakably visible to the tracked user via a native OS toast, _and_ make sure that toast is correctly attributed to "Hindsight" with the app icon — even in dev mode and even before an installer-created Start Menu shortcut exists.

This plan was written **retroactively** after the feature shipped. It exists to record _why_ the AUMID-registration code in `apps/desktop/src-tauri/src/win_aumid.rs` is there, since that file isn't self-explanatory and removing it would silently regress the toast branding.

## Source-of-truth references

- Privacy stance on "visible always": [docs/09-privacy-and-ethics.md](../../docs/09-privacy-and-ethics.md) — principle #1
- Desktop architecture: [docs/06-desktop-app.md](../../docs/06-desktop-app.md) "Capture notifications (Windows AUMID)"
- Glossary: AUMID, Capture notification: [docs/11-glossary.md](../../docs/11-glossary.md)
- Plugin: `tauri-plugin-notification` v2
- Rust source: [apps/desktop/src-tauri/src/win_aumid.rs](../../apps/desktop/src-tauri/src/win_aumid.rs), [apps/desktop/src-tauri/src/scheduler.rs](../../apps/desktop/src-tauri/src/scheduler.rs) (notify_capture helper)

## Decisions captured here

1. **OS toast over in-app overlay.** The original plan called for a transparent overlay window that "flashes" at capture time. Replaced with native OS toasts because:
   - Works without an always-on second window (lower memory).
   - Consistent appearance across OSes.
   - User can mute it via OS notification settings if they want — and that's an _audited, deliberate_ action on their end, not a one-click app toggle. Aligns with the privacy stance: visibility is a choice the user makes at the OS level, not something the app silences for them.
2. **Fire only after the capture is fully persisted.** In `scheduler.rs`, `notify_capture(&app)` runs in the `Ok(Ok(shot))` branch _after_ `persist_capture` succeeds. A capture that failed to encode or persist doesn't produce a toast — the toast is a truthful signal.
3. **Toast text is fixed.** Title "Hindsight", body "Screenshot captured". No active-app or project name in the body — that would risk leaking context (active window titles are sensitive) and the toast is supposed to be a presence signal, not a status report.
4. **AUMID registration runs at startup before any plugin init.** `win_aumid::register()` is called at the very top of `run()` in `lib.rs`, before `plugin(tauri_plugin_notification::init())`. Order matters: the first toast inherits whatever AUMID the process has at that moment.
5. **Both AUMID legs are required.**
   - `SetCurrentProcessExplicitAppUserModelID` alone makes Windows look up "this process's AUMID" → finds nothing → falls back to the parent process name.
   - Registry entry alone doesn't change what AUMID _this process_ uses — it just sits there.
   - Together, the process declares its AUMID, and Windows finds DisplayName + Icon for that AUMID. We need both.
6. **HKCU only, no admin prompts.** The registry write goes to `HKEY_CURRENT_USER\Software\Classes\AppUserModelId\app.hindsight.desktop`. Per-user, no UAC. Acceptable side effect: the entry stays on disk after uninstall until manually deleted (`reg delete "HKCU\Software\Classes\AppUserModelId\app.hindsight.desktop"`). Documented in [docs/06-desktop-app.md](../../docs/06-desktop-app.md).
7. **Icon path resolution tries two locations.**
   - Installed build: `<exe_dir>\icons\icon.ico` (NSIS installer drops the icon there).
   - Dev mode: `<exe_dir>\..\..\icons\icon.ico` (relative to `target\debug\hindsight.exe`).
   - If neither exists, we skip `IconUri` and let Windows use the .exe's embedded icon. The DisplayName still wins over the parent-process fallback.
8. **All failures are non-fatal.** `register()` logs warnings via `tracing` but never panics. A broken registry write or a missing `Win32_UI_Shell` capability must not stop the app from launching.
9. **macOS / Linux are no-ops.** The whole module is gated by `#[cfg(target_os = "windows")]` and only compiled on Windows. When macOS support lands, that platform uses its own bundle identifier mechanism and needs no equivalent registration — the bundle ID set in `tauri.conf.json` is enough for `NSUserNotification`.
10. **Capability permission added: `notification:default`.** In [`apps/desktop/src-tauri/capabilities/default.json`](../../apps/desktop/src-tauri/capabilities/default.json). Without it, the plugin would refuse calls from the frontend (though we call it from Rust, where the permission check is looser, the capability is still required for the plugin to be usable end-to-end).

## Out of scope for this plan (deferred)

- **Per-user "mute capture toasts" toggle in the app.** Deliberately not built — see decision #1. If we ever build it, it has to be paired with a louder visibility surface (e.g. a banner on the picker screen showing "Capture toasts: muted") so the absence of toasts doesn't equal "no tracking."
- **macOS notifications.** Out of scope until macOS support returns to the roadmap.
- **Rich toast content** (project name, action buttons). Risk of leaking active-app context; decision #3 keeps the body fixed.
- **Toast click → open app.** Default click behavior brings the app to front via Tauri's default handler; we haven't customized the click action beyond that.

## Files this plan added or changed

Rust:

- **New:** [apps/desktop/src-tauri/src/win_aumid.rs](../../apps/desktop/src-tauri/src/win_aumid.rs)
- **Modified:** [apps/desktop/src-tauri/src/lib.rs](../../apps/desktop/src-tauri/src/lib.rs) — `mod win_aumid;`, registered the plugin, called `win_aumid::register()` at top of `run()`.
- **Modified:** [apps/desktop/src-tauri/src/scheduler.rs](../../apps/desktop/src-tauri/src/scheduler.rs) — added `notify_capture(&app)` helper, called in the post-persist branch of the capture loop.

Cargo:

- **Modified:** [apps/desktop/src-tauri/Cargo.toml](../../apps/desktop/src-tauri/Cargo.toml) — added `tauri-plugin-notification = "2"`, `winreg = "0.55"`, and `Win32_UI_Shell` feature to the `windows` crate's Windows-target deps.

Capabilities:

- **Modified:** [apps/desktop/src-tauri/capabilities/default.json](../../apps/desktop/src-tauri/capabilities/default.json) — added `notification:default`.

## Done when

- ✅ Every successful screenshot capture produces a native OS toast titled "Hindsight" with body "Screenshot captured".
- ✅ In an installed build, the toast shows "Hindsight" as the source app with the Hindsight icon, regardless of launch path (Start Menu, taskbar pin, double-click on .exe).
- ✅ In `tauri dev`, the toast also shows "Hindsight", not "Windows PowerShell" / "cmd" / the parent shell's name.
- ✅ Cargo `check` and Cargo `build` both clean in release mode.
- ✅ The privacy doc reflects the OS-toast visibility mechanism.
