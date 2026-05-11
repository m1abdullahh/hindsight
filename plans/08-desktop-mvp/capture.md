# Desktop MVP — Capture + Activity Counters

The capture pipeline is two things working together:

1. **Capture command** — a Tauri command that grabs a screenshot from monitor 0, JPEG-encodes it, and returns the bytes + metadata.
2. **Activity counters** — Windows low-level keyboard + mouse hooks running on a dedicated thread. They increment two atomic counters; the capture flow reads-and-resets per shot.

This file covers the Rust side of both. The capture _scheduler_ (when to fire, with random offset) lives in [outbox.md](./outbox.md) — it triggers this command at the right moment.

**Windows-specific note:** unlike macOS, Windows does not gate screen capture or keyboard hooks behind a per-app permission grant. The app starts capturing immediately when the user clicks Start. No System Settings deep-link, no restart-after-grant, no all-zero-image heuristic. This is the biggest reason Windows-first is faster to ship than Mac-first.

## `src-tauri/src/capture.rs`

```rust
use std::time::SystemTime;

use image::{codecs::jpeg::JpegEncoder, ColorType};
use screenshots::Screen;
use serde::Serialize;

#[derive(Serialize)]
pub struct CapturedScreenshot {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub captured_at_ms: i64,
    pub monitor_index: u32,
}

#[derive(Debug, thiserror::Error, Serialize)]
pub enum CaptureError {
    #[error("no displays available")]
    NoDisplays,
    #[error("capture failed: {0}")]
    CaptureFailed(String),
    #[error("encode failed: {0}")]
    EncodeFailed(String),
}

const JPEG_QUALITY: u8 = 75;

#[tauri::command]
pub fn capture_screenshot() -> Result<CapturedScreenshot, CaptureError> {
    let screens = Screen::all().map_err(|e| CaptureError::CaptureFailed(e.to_string()))?;
    let primary = screens.first().ok_or(CaptureError::NoDisplays)?;

    let image = primary
        .capture()
        .map_err(|e| CaptureError::CaptureFailed(e.to_string()))?;

    let width = image.width();
    let height = image.height();
    let rgba = image.into_raw(); // Vec<u8> in RGBA order

    // Re-encode RGBA → JPEG (drops alpha, which is fine for screenshots).
    let mut buf = Vec::with_capacity((width * height) as usize);
    {
        let mut encoder = JpegEncoder::new_with_quality(&mut buf, JPEG_QUALITY);
        encoder
            .encode(&rgba, width, height, ColorType::Rgba8.into())
            .map_err(|e| CaptureError::EncodeFailed(e.to_string()))?;
    }

    let captured_at_ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    Ok(CapturedScreenshot {
        bytes: buf,
        width,
        height,
        captured_at_ms,
        monitor_index: 0,
    })
}
```

Notes:

- The `screenshots` crate uses **DXGI Desktop Duplication** under the hood on Windows — it's the fast, GPU-friendly path. It doesn't trigger any UAC prompt and doesn't need elevation.
- **Multi-monitor:** `Screen::all()` returns one entry per monitor. We use `[0]` for v0.5; multi-monitor lands in Plan 09 along with monitor identity tracking (the array order across reboots isn't reliably stable).
- **DPI-aware:** the returned image is at the monitor's native resolution. On a 4K display you'll get a 3840×2160 buffer — JPEG at quality 75 keeps file size around 250–500 KB even at that resolution.

## Activity counters — `src-tauri/src/activity.rs`

Two `AtomicU64` counters bumped from a global event hook thread. The capture flow reads-and-resets them just before each capture, attaching the values to the outbox row.

### The shared counter struct

```rust
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[derive(Default)]
pub struct ActivityCounters {
    keyboard: AtomicU64,
    mouse: AtomicU64,
}

impl ActivityCounters {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Read both counters and reset to zero. Atomic per-counter, but **not**
    /// atomic across the pair — captures don't need exact pairing.
    pub fn read_and_reset(&self) -> (u64, u64) {
        let kb = self.keyboard.swap(0, Ordering::SeqCst);
        let ms = self.mouse.swap(0, Ordering::SeqCst);
        (kb, ms)
    }

    pub fn bump_keyboard(&self) {
        self.keyboard.fetch_add(1, Ordering::Relaxed);
    }

    pub fn bump_mouse(&self) {
        self.mouse.fetch_add(1, Ordering::Relaxed);
    }
}
```

### Windows hook thread

Windows low-level hooks fire on the thread that called `SetWindowsHookEx`. They require a Windows message loop (`GetMessageW` / `DispatchMessageW`) on that thread. We dedicate one OS thread to this for the app's lifetime.

The hook procs receive a `KBDLLHOOKSTRUCT` (keyboard) or `MSLLHOOKSTRUCT` (mouse) — but **we never read the contents** beyond using the `wParam` to know what kind of event fired. We bump the counter and call `CallNextHookEx` so other apps still get the event.

```rust
// PRIVACY-CRITICAL CODE
//
// The hook procs below receive Windows event structs containing keystroke
// data, mouse coordinates, scroll deltas, etc. The ONLY operation permitted
// in this module on those structs is examining `wParam` to discriminate
// event type, then incrementing the relevant counter. We must NEVER:
//
//   - Read the KBDLLHOOKSTRUCT's `vkCode`, `scanCode`, or `flags`
//   - Read the MSLLHOOKSTRUCT's `pt.x`, `pt.y`, `mouseData`, or `flags`
//   - Pass either struct to any other module
//   - Log, persist, or transmit any event-derived value other than counter totals
//
// Violations are a privacy / legal incident, not a bug. Reviewers: enforce
// strictly. Add a no-blame revert and a code-owners review on this file.

#[cfg(target_os = "windows")]
mod hooks {
    use std::sync::Arc;
    use std::sync::OnceLock;

    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW,
        UnhookWindowsHookEx, HHOOK, MSG, WH_KEYBOARD_LL, WH_MOUSE_LL,
        WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_RBUTTONDOWN, WM_XBUTTONDOWN,
    };

    use super::ActivityCounters;

    // The hook procs need access to the counters. We use a OnceLock because
    // the procs are `extern "system" fn`s that can't carry closures.
    static COUNTERS: OnceLock<Arc<ActivityCounters>> = OnceLock::new();

    pub fn install(counters: Arc<ActivityCounters>) {
        let _ = COUNTERS.set(counters);

        std::thread::Builder::new()
            .name("hindsight-activity-hooks".into())
            .spawn(|| {
                let kbd_hook: HHOOK = unsafe {
                    SetWindowsHookExW(WH_KEYBOARD_LL, Some(low_level_keyboard_proc), None, 0)
                        .expect("install keyboard hook")
                };
                let mouse_hook: HHOOK = unsafe {
                    SetWindowsHookExW(WH_MOUSE_LL, Some(low_level_mouse_proc), None, 0)
                        .expect("install mouse hook")
                };

                // Standard Win32 message pump. Hooks fire from inside this loop.
                let mut msg = MSG::default();
                unsafe {
                    while GetMessageW(&mut msg, None, 0, 0).into() {
                        let _ = DispatchMessageW(&msg);
                    }
                }

                // Unreachable in practice (we never PostQuitMessage), but
                // tidy if the message loop ever exits.
                unsafe {
                    let _ = UnhookWindowsHookEx(kbd_hook);
                    let _ = UnhookWindowsHookEx(mouse_hook);
                }
            })
            .expect("spawn hook thread");
    }

    // Fires for every key-down / key-up / syskey event. We count key-DOWN
    // events only (per docs/06-desktop-app.md "key-press events").
    extern "system" fn low_level_keyboard_proc(
        n_code: i32,
        w_param: WPARAM,
        l_param: LPARAM,
    ) -> LRESULT {
        if n_code >= 0 {
            // wParam tells us key-down vs key-up; we count down only.
            // NOTE: deliberately do NOT dereference l_param (the
            // KBDLLHOOKSTRUCT pointer). We only need the event kind.
            const WM_KEYDOWN: usize = 0x0100;
            const WM_SYSKEYDOWN: usize = 0x0104;
            if w_param.0 == WM_KEYDOWN || w_param.0 == WM_SYSKEYDOWN {
                if let Some(c) = COUNTERS.get() {
                    c.bump_keyboard();
                }
            }
        }
        unsafe { CallNextHookEx(None, n_code, w_param, l_param) }
    }

    // Fires for every mouse event (move, click, wheel). We count CLICK-DOWN
    // only — moves are too noisy without debouncing (Plan 09 adds it).
    extern "system" fn low_level_mouse_proc(
        n_code: i32,
        w_param: WPARAM,
        l_param: LPARAM,
    ) -> LRESULT {
        if n_code >= 0 {
            // NOTE: deliberately do NOT dereference l_param (the MSLLHOOKSTRUCT
            // pointer). We only need the event kind from wParam.
            let kind = w_param.0 as u32;
            if kind == WM_LBUTTONDOWN
                || kind == WM_RBUTTONDOWN
                || kind == WM_MBUTTONDOWN
                || kind == WM_XBUTTONDOWN
            {
                if let Some(c) = COUNTERS.get() {
                    c.bump_mouse();
                }
            }
        }
        unsafe { CallNextHookEx(None, n_code, w_param, l_param) }
    }
}

#[cfg(target_os = "windows")]
pub fn install_event_hooks(counters: Arc<ActivityCounters>) {
    hooks::install(counters);
}

// Stub on non-Windows so the codebase still compiles cross-platform during
// development. Plan 09 adds the macOS implementation.
#[cfg(not(target_os = "windows"))]
pub fn install_event_hooks(_counters: Arc<ActivityCounters>) {
    tracing::warn!("activity hooks not implemented for this OS");
}
```

### What we're explicitly NOT doing

- **Counting mouse moves.** A naive count fires hundreds of times per second; debouncing is needed. Plan 09 adds it. For v0.5, click-only is good enough — "did the user touch the mouse" is the question we're really answering, not "how much".
- **Counting wheel scrolls.** Same reason. Skipped.
- **Any reading of the event payload.** As the privacy comment block notes, we never look inside the `KBDLLHOOKSTRUCT` or `MSLLHOOKSTRUCT`. The `wParam` discriminator tells us event kind without touching the struct contents.

### Permission story on Windows

Unlike macOS Input Monitoring, Windows does not gate `SetWindowsHookEx(WH_KEYBOARD_LL, ...)` behind a per-app permission. Hooks just work, no UAC prompt, no Settings page to grant. The user clicks Start, hooks install, counters tick. Done.

(Anti-cheat / kernel-mode protected processes — games like Valorant, banking apps — sometimes exclude themselves from low-level hooks, so counts go to zero while those apps have focus. This is normal and we don't try to work around it.)

## Hooking everything up in `lib.rs`

```rust
// In setup:
let counters = activity::ActivityCounters::new();
activity::install_event_hooks(counters.clone());
app.manage(counters); // available to Tauri commands via `State<Arc<ActivityCounters>>`
```

The capture-scheduler task (defined in [outbox.md](./outbox.md)) holds an `Arc<ActivityCounters>` reference. Just before persisting a capture to the outbox, it calls `counters.read_and_reset()` and writes the two values into the row.

## Files this plan adds

- `apps/desktop/src-tauri/src/capture.rs`
- `apps/desktop/src-tauri/src/activity.rs`
- New commands registered in `lib.rs`'s `invoke_handler!`: `capture_screenshot`

## Testing

- **Unit-testable in Rust:** `ActivityCounters` methods (in [testing.md](./testing.md)). The hook procs themselves are not unit-testable in the standard sense — they require a real OS message pump. Smoke test catches misbehaviour.
- **Manual on Windows:** the entire flow. Documented in [testing.md](./testing.md).
- **Cross-platform compile only on non-Windows.** The `#[cfg(target_os = "windows")]` guards keep the macOS / Linux build of these files no-op'd; Plan 09 fills in the macOS half behind a matching `#[cfg(target_os = "macos")]`.
