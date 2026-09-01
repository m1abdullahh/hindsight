//! OS-level permissions that the tracker needs before it can do its job.
//!
//! Right now this is just macOS Screen Recording. macOS 10.15+ silently
//! returns blank frames from screencapture APIs unless the user has
//! explicitly granted permission to Hindsight in
//! System Settings → Privacy & Security → Screen Recording.
//!
//! We don't have an equivalent on Windows (screencapture has no permission
//! gate) or on Linux/X11 (no gate at all). Linux/Wayland does gate capture,
//! but through the ScreenCast portal, which grants once and is then restored
//! silently from a saved token — see `wayland_capture`. That consent is
//! collected by the portal on the first capture rather than up front, so
//! there is still nothing for this module to check.

use serde::Serialize;

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)] // Denied/NotSupported only emit on macOS; harmless on other targets.
pub enum PermissionStatus {
    Granted,
    Denied,
    NotSupported,
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// Current screen-capture permission. On non-macOS platforms we always
/// report Granted so the renderer can skip the permission gate entirely.
pub fn check_screen_capture() -> PermissionStatus {
    #[cfg(target_os = "macos")]
    unsafe {
        if CGPreflightScreenCaptureAccess() {
            PermissionStatus::Granted
        } else {
            PermissionStatus::Denied
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        PermissionStatus::Granted
    }
}

/// Triggers the OS permission dialog on the first call. Subsequent calls
/// are no-ops and just return the latest status (because once the user has
/// answered, future grants must go through System Settings).
pub fn request_screen_capture() -> PermissionStatus {
    #[cfg(target_os = "macos")]
    unsafe {
        let _ = CGRequestScreenCaptureAccess();
    }
    check_screen_capture()
}
