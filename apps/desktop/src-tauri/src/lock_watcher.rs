// Watches the OS session-lock state and emits `lock-state-changed` whenever
// it flips. Lock immediately pauses tracking (faster than the 5-min idle
// threshold) and screenshots stop on the next scheduler tick. Unlock resumes.
//
// The renderer treats this as a separate PauseReason ('locked') from idle:
// unlike idle, a locked period does NOT accrue into `totalIdleSeconds` — it
// is simply a gap in the time entry, since the user is definitively away
// from the machine (not just AFK at the keyboard).
//
// Each platform uses a different detection primitive but the public shape
// is identical: a 1-second poll loop emitting transitions only.
//
//   - Windows: WTSQuerySessionInformation(WTSSessionInfoEx) — read the
//     SessionFlags lock bit. The documented, message-pump-free way to
//     poll lock state.
//   - macOS:   CGSessionCopyCurrentDictionary() — read the
//     kCGSSessionScreenIsLockedKey field from the returned dict.
//   - Linux:   org.freedesktop.ScreenSaver.GetActive over DBus — works on
//     GNOME, KDE, XFCE, Cinnamon, MATE. Falls back gracefully on systems
//     where the service is missing.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::time::sleep;

#[derive(Clone, Serialize)]
struct LockPayload {
    locked: bool,
}

pub fn spawn(app: AppHandle) -> tokio::task::JoinHandle<()> {
    tracing::info!("lock_watcher: starting");
    tokio::spawn(async move {
        let mut last_emitted: Option<bool> = None;
        loop {
            let locked = detect_locked().await;
            if last_emitted != Some(locked) {
                if let Err(e) = app.emit("lock-state-changed", LockPayload { locked }) {
                    tracing::warn!(err = %e, "failed to emit lock-state-changed");
                } else {
                    tracing::info!(locked, "lock_watcher: state changed");
                }
                last_emitted = Some(locked);
            }
            sleep(Duration::from_secs(1)).await;
        }
    })
}

async fn detect_locked() -> bool {
    #[cfg(target_os = "windows")]
    {
        windows_impl::is_locked()
    }
    #[cfg(target_os = "macos")]
    {
        macos_impl::is_locked()
    }
    #[cfg(target_os = "linux")]
    {
        linux_impl::is_locked().await
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        false
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::RemoteDesktop::{
        WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW,
        WTS_CURRENT_SESSION,
    };

    // wtsapi32.h: on Windows 8+ (incl. the Windows 10 target here) the
    // SessionFlags field is 0 when the session is locked, 1 when unlocked.
    // (Only Windows 7 / Server 2008 R2 swap these — not a concern.)
    const WTS_SESSIONSTATE_LOCK: i32 = 0;

    /// Reads the session lock flag via WTSQuerySessionInformation — the
    /// documented, poll-friendly API (no window or message pump needed).
    /// Returns false on any failure so a transient query error can't wedge
    /// the tracker in a permanently-paused state.
    pub fn is_locked() -> bool {
        unsafe {
            let mut buffer = windows::core::PWSTR::null();
            let mut bytes: u32 = 0;
            // WTS_CURRENT_SERVER_HANDLE is a null HANDLE.
            let result = WTSQuerySessionInformationW(
                HANDLE::default(),
                WTS_CURRENT_SESSION,
                WTSSessionInfoEx,
                &mut buffer,
                &mut bytes,
            );
            if result.is_err() || buffer.is_null() {
                return false;
            }
            // Despite the LPWSTR* out-param typing, for WTSSessionInfoEx the
            // buffer is actually a WTSINFOEXW struct.
            let info = &*(buffer.0 as *const WTSINFOEXW);
            let locked = info.Level == 1
                && info.Data.WTSInfoExLevel1.SessionFlags == WTS_SESSIONSTATE_LOCK;
            WTSFreeMemory(buffer.0 as *mut core::ffi::c_void);
            locked
        }
    }
}

#[cfg(target_os = "macos")]
mod macos_impl {
    // Pure C FFI against the system CoreFoundation / ApplicationServices
    // frameworks — no Rust wrapper crate. These C ABIs are decades-stable, so
    // this avoids both an extra dependency and any wrapper-crate version drift.
    use std::ffi::c_void;
    use std::ptr;

    type CFTypeRef = *const c_void;

    // kCFStringEncodingUTF8
    const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn CGSessionCopyCurrentDictionary() -> CFTypeRef;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            alloc: CFTypeRef,
            c_str: *const i8,
            encoding: u32,
        ) -> CFTypeRef;
        fn CFDictionaryGetValueIfPresent(
            dict: CFTypeRef,
            key: CFTypeRef,
            value: *mut CFTypeRef,
        ) -> u8;
        fn CFBooleanGetValue(boolean: CFTypeRef) -> u8;
        fn CFRelease(cf: CFTypeRef);
    }

    /// Reads the session dictionary the WindowServer maintains and checks
    /// `CGSSessionScreenIsLocked`. The key is absent (not `false`) when the
    /// screen is unlocked, so missing-or-false both mean unlocked.
    pub fn is_locked() -> bool {
        unsafe {
            let dict = CGSessionCopyCurrentDictionary();
            if dict.is_null() {
                return false;
            }
            let key = CFStringCreateWithCString(
                ptr::null(),
                c"CGSSessionScreenIsLocked".as_ptr(),
                CF_STRING_ENCODING_UTF8,
            );
            let mut value: CFTypeRef = ptr::null();
            let found = CFDictionaryGetValueIfPresent(dict, key, &mut value);
            let locked = found != 0 && !value.is_null() && CFBooleanGetValue(value) != 0;
            if !key.is_null() {
                CFRelease(key);
            }
            CFRelease(dict);
            locked
        }
    }
}

#[cfg(target_os = "linux")]
mod linux_impl {
    use tokio::sync::OnceCell;
    use zbus::Connection;

    // The DBus session bus lives for the whole login session, so one
    // connection is reused across every poll tick. Re-connecting every
    // second would mean an auth handshake per tick — needless CPU wakeups.
    static CONN: OnceCell<Connection> = OnceCell::const_new();

    /// Calls `org.freedesktop.ScreenSaver.GetActive`. Active == locked.
    /// Returns false (i.e. "unlocked") on any error, including the case
    /// where the service isn't running, so a missing screensaver doesn't
    /// keep the tracker permanently paused.
    pub async fn is_locked() -> bool {
        let conn = match CONN.get_or_try_init(Connection::session).await {
            Ok(c) => c,
            Err(e) => {
                tracing::trace!(err = %e, "dbus session connect failed");
                return false;
            }
        };
        match conn
            .call_method(
                Some("org.freedesktop.ScreenSaver"),
                "/org/freedesktop/ScreenSaver",
                Some("org.freedesktop.ScreenSaver"),
                "GetActive",
                &(),
            )
            .await
        {
            Ok(reply) => reply.body().deserialize::<bool>().unwrap_or(false),
            Err(e) => {
                // Most distros: NameHasNoOwner when no screensaver is
                // installed. trace-level so it doesn't spam every tick.
                tracing::trace!(err = %e, "screensaver GetActive failed");
                false
            }
        }
    }
}
