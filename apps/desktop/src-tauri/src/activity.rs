// PRIVACY-CRITICAL CODE
//
// The hook procs in this file run on every keystroke and mouse event the user
// generates. The ONLY operation permitted on the event payloads is examining
// `wParam` to discriminate event type, then incrementing a counter. We must
// NEVER:
//
//   - Read the KBDLLHOOKSTRUCT's `vkCode`, `scanCode`, or `flags`
//   - Read the MSLLHOOKSTRUCT's `pt.x`, `pt.y`, `mouseData`, or `flags`
//   - Pass either struct to any other module
//   - Log, persist, or transmit any event-derived value other than counter totals
//
// Violations are a privacy / legal incident, not a bug. Reviewers: enforce
// this strictly.

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

    /// Read both counters and reset to zero. Per-counter atomic; not atomic
    /// across the pair — captures don't need exact pairing.
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

#[cfg(target_os = "windows")]
mod hooks {
    use std::sync::Arc;

    use once_cell::sync::OnceCell;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
        HHOOK, MSG, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_LBUTTONDOWN, WM_MBUTTONDOWN,
        WM_RBUTTONDOWN, WM_SYSKEYDOWN, WM_XBUTTONDOWN,
    };

    use super::ActivityCounters;

    static COUNTERS: OnceCell<Arc<ActivityCounters>> = OnceCell::new();

    pub fn install(counters: Arc<ActivityCounters>) {
        if COUNTERS.set(counters).is_err() {
            tracing::warn!("activity hooks already installed");
            return;
        }

        std::thread::Builder::new()
            .name("hindsight-activity-hooks".into())
            .spawn(|| run_hook_thread())
            .expect("spawn hook thread");
    }

    fn run_hook_thread() {
        // SAFETY: SetWindowsHookExW expects valid hook proc fn pointers; ours
        // are static `extern "system" fn`s. The hModule arg is None (HMODULE
        // null) which is documented as valid for low-level hooks.
        let kbd_hook: HHOOK = unsafe {
            match SetWindowsHookExW(WH_KEYBOARD_LL, Some(low_level_keyboard_proc), None, 0) {
                Ok(h) => h,
                Err(e) => {
                    tracing::error!(?e, "SetWindowsHookExW(WH_KEYBOARD_LL) failed");
                    return;
                }
            }
        };
        let mouse_hook: HHOOK = unsafe {
            match SetWindowsHookExW(WH_MOUSE_LL, Some(low_level_mouse_proc), None, 0) {
                Ok(h) => h,
                Err(e) => {
                    tracing::error!(?e, "SetWindowsHookExW(WH_MOUSE_LL) failed");
                    let _ = UnhookWindowsHookEx(kbd_hook);
                    return;
                }
            }
        };

        tracing::info!("activity hooks installed");

        // Standard Win32 message pump. Hooks fire from inside this loop.
        let mut msg = MSG::default();
        unsafe {
            while GetMessageW(&mut msg, None, 0, 0).into() {
                let _ = DispatchMessageW(&msg);
            }
        }

        // Unreachable in practice (we never PostQuitMessage), but tidy if
        // the message loop ever exits.
        unsafe {
            let _ = UnhookWindowsHookEx(kbd_hook);
            let _ = UnhookWindowsHookEx(mouse_hook);
        }
    }

    // Keyboard low-level hook proc.
    //
    // PRIVACY: we read `w_param` only to discriminate key-down vs key-up.
    // We do NOT dereference `l_param` (the KBDLLHOOKSTRUCT pointer).
    extern "system" fn low_level_keyboard_proc(
        n_code: i32,
        w_param: WPARAM,
        l_param: LPARAM,
    ) -> LRESULT {
        if n_code >= 0 {
            let kind = w_param.0 as u32;
            if kind == WM_KEYDOWN || kind == WM_SYSKEYDOWN {
                if let Some(c) = COUNTERS.get() {
                    c.bump_keyboard();
                }
            }
        }
        unsafe { CallNextHookEx(None, n_code, w_param, l_param) }
    }

    // Mouse low-level hook proc.
    //
    // PRIVACY: we read `w_param` only to discriminate event type.
    // We do NOT dereference `l_param` (the MSLLHOOKSTRUCT pointer).
    extern "system" fn low_level_mouse_proc(
        n_code: i32,
        w_param: WPARAM,
        l_param: LPARAM,
    ) -> LRESULT {
        if n_code >= 0 {
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

// Stub on non-Windows so the codebase still typechecks during cross-platform
// development. Plan 09 adds the macOS implementation behind cfg(target_os = "macos").
#[cfg(not(target_os = "windows"))]
pub fn install_event_hooks(_counters: Arc<ActivityCounters>) {
    tracing::warn!("activity hooks not implemented on this OS");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

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
