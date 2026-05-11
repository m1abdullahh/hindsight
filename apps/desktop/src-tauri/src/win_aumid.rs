// Registers an AppUserModelID so toast notifications show "Hindsight" instead
// of falling back to the launching shell's name (e.g. "Windows PowerShell" in
// `tauri dev`). Without this, Windows looks up the AUMID inherited from the
// parent process and uses *its* DisplayName for the toast source.
//
// Idempotent: safe to call on every launch. HKCU-scoped, no admin needed.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;

use windows::core::PCWSTR;
use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

const AUMID: &str = "app.hindsight.desktop";
const DISPLAY_NAME: &str = "Hindsight";
const SUBKEY: &str = r"Software\Classes\AppUserModelId\app.hindsight.desktop";

pub fn register() {
    let wide: Vec<u16> = OsStr::new(AUMID)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        if let Err(e) = SetCurrentProcessExplicitAppUserModelID(PCWSTR(wide.as_ptr())) {
            tracing::warn!(err = %e, "SetCurrentProcessExplicitAppUserModelID failed");
        }
    }

    match RegKey::predef(HKEY_CURRENT_USER).create_subkey(SUBKEY) {
        Ok((key, _disposition)) => {
            if let Err(e) = key.set_value("DisplayName", &DISPLAY_NAME) {
                tracing::warn!(err = %e, "could not write AUMID DisplayName");
            }
            if let Some(icon) = locate_icon() {
                if let Err(e) = key.set_value("IconUri", &icon) {
                    tracing::warn!(err = %e, "could not write AUMID IconUri");
                }
            }
        }
        Err(e) => tracing::warn!(err = %e, "could not create AUMID registry subkey"),
    }
}

fn locate_icon() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;

    // Production install: bundle drops icon next to the .exe.
    let prod = exe_dir.join("icons").join("icon.ico");
    if prod.exists() {
        return prod.to_str().map(String::from);
    }

    // Dev mode: target/debug/hindsight.exe → ../../icons/icon.ico
    let dev = exe_dir.join("..").join("..").join("icons").join("icon.ico");
    if dev.exists() {
        return canonical(&dev);
    }
    None
}

fn canonical(p: &std::path::Path) -> Option<String> {
    let abs: PathBuf = p.canonicalize().ok()?;
    let s = abs.to_string_lossy().to_string();
    // canonicalize() returns a UNC path with the \\?\ prefix on Windows;
    // strip it since some Windows APIs choke on it.
    Some(s.strip_prefix(r"\\?\").map(String::from).unwrap_or(s))
}
