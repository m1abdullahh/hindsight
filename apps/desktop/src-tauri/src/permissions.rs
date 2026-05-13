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
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// Current screen-capture permission. On non-macOS platforms we always
/// report Granted so the renderer can skip the permission gate entirely.
///
/// On macOS, `CGPreflightScreenCaptureAccess()` is unreliable on unsigned
/// builds (returns false even when the OS would actually allow capture), so
/// we don't use it. Instead:
///   1. Fast path: a marker file at `marker_path` means we've previously
///      verified that real captures work; trust that and return Granted.
///   2. Slow path: attempt a real capture and inspect the pixels. macOS
///      returns a blank/black image when permission is denied, so any
///      non-zero pixel sample is sufficient evidence of a grant. On success
///      we persist the marker so future launches skip the probe entirely.
pub fn check_screen_capture(marker_path: &Path) -> PermissionStatus {
    #[cfg(target_os = "macos")]
    {
        if marker_path.exists() {
            return PermissionStatus::Granted;
        }
        if probe_capture() {
            persist_marker(marker_path);
            PermissionStatus::Granted
        } else {
            PermissionStatus::Denied
        }
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
fn probe_capture() -> bool {
    use screenshots::Screen;

    let screens = match Screen::all() {
        Ok(s) => s,
        Err(_) => return false,
    };
    let Some(screen) = screens.first() else {
        return false;
    };
    let img = match screen.capture() {
        Ok(i) => i,
        Err(_) => return false,
    };
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return false;
    }
    // Sample ~100 pixels across the image. macOS hands back an all-zero
    // image when permission is denied, so a single non-zero pixel is
    // sufficient evidence the capture actually saw the screen.
    let total = (w as usize).saturating_mul(h as usize);
    let stride = (total / 100).max(1);
    for (_, _, pixel) in img.enumerate_pixels().step_by(stride) {
        if pixel[0] != 0 || pixel[1] != 0 || pixel[2] != 0 {
            return true;
        }
    }
    false
}

#[cfg(target_os = "macos")]
fn persist_marker(marker_path: &Path) {
    if let Some(parent) = marker_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(marker_path, b"granted");
}
