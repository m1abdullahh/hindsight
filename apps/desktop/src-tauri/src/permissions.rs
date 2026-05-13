//! OS-level permissions that the tracker needs before it can do its job.
//!
//! Right now this is just macOS Screen Recording. macOS 10.15+ silently
//! returns blank frames from screencapture APIs unless the user has
//! explicitly granted permission to Hindsight in
//! System Settings → Privacy & Security → Screen Recording.
//!
//! We don't have an equivalent on Windows (screencapture has no permission
//! gate) or Linux (X11 doesn't gate; Wayland gates per-portal which the
//! `screenshots` crate handles transparently).

use std::path::Path;

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
///
/// Signal priority on macOS:
///   1. `CGPreflightScreenCaptureAccess()` — the canonical Apple API.
///      Reliable for properly signed apps (was unreliable historically
///      for unsigned/ad-hoc builds, which is why a marker fallback exists).
///   2. Marker file persisted after a prior successful grant. Defensive
///      fallback for the rare case where preflight returns a false negative.
pub fn check_screen_capture(marker_path: &Path) -> PermissionStatus {
    #[cfg(target_os = "macos")]
    {
        let granted = unsafe { CGPreflightScreenCaptureAccess() };
        if granted {
            persist_marker(marker_path);
            return PermissionStatus::Granted;
        }
        if marker_path.exists() {
            return PermissionStatus::Granted;
        }
        PermissionStatus::Denied
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = marker_path;
        PermissionStatus::Granted
    }
}

/// Triggers the OS permission dialog on the first call. Subsequent calls
/// are no-ops and just return the latest status (because once the user has
/// answered, future grants must go through System Settings).
pub fn request_screen_capture(marker_path: &Path) -> PermissionStatus {
    #[cfg(target_os = "macos")]
    unsafe {
        let _ = CGRequestScreenCaptureAccess();
    }
    check_screen_capture(marker_path)
}

#[cfg(target_os = "macos")]
fn persist_marker(marker_path: &Path) {
    if marker_path.exists() {
        return;
    }
    if let Some(parent) = marker_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(marker_path, b"granted");
}
