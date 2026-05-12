// Registers an AppUserModelID so toast notifications show "Hindsight" instead
// of falling back to the launching shell's name (e.g. "Windows PowerShell" in
// `tauri dev`). Without this, Windows looks up the AUMID inherited from the
// parent process and uses *its* DisplayName for the toast source.
//
// We do three things:
//   1. SetCurrentProcessExplicitAppUserModelID — process-wide identity.
//   2. HKCU registry — DisplayName + IconUri keyed on the AUMID.
//   3. Start menu shortcut with the AUMID property — the only mechanism
//      `tauri-winrt-notification` consistently honors. Without this, dev-mode
//      toasts still attribute to PowerShell on many Windows builds.
//
// All steps are idempotent and safe to run every launch. HKCU-scoped, no
// admin needed.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use windows::core::{Interface, GUID, PCWSTR, PROPVARIANT};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, PROPERTYKEY};
use windows::Win32::UI::Shell::{IShellLinkW, SetCurrentProcessExplicitAppUserModelID, ShellLink};
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

const AUMID: &str = "app.hindsight.desktop";
const DISPLAY_NAME: &str = "Hindsight";
const SUBKEY: &str = r"Software\Classes\AppUserModelId\app.hindsight.desktop";
const SHORTCUT_FILENAME: &str = "Hindsight.lnk";

// System.AppUserModel.ID — the property that Toast notifications read off the
// Start menu shortcut to decide the source name/icon. Defined inline so we
// don't need to enable the Win32_Storage_EnhancedStorage feature just for one
// constant.
const PKEY_APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
    pid: 5,
};

pub fn register() {
    set_process_aumid();
    write_hkcu_aumid();
    if let Err(e) = ensure_start_menu_shortcut() {
        tracing::warn!(err = %e, "could not create AUMID start menu shortcut");
    }
}

fn set_process_aumid() {
    let wide: Vec<u16> = OsStr::new(AUMID)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        if let Err(e) = SetCurrentProcessExplicitAppUserModelID(PCWSTR(wide.as_ptr())) {
            tracing::warn!(err = %e, "SetCurrentProcessExplicitAppUserModelID failed");
        }
    }
}

fn write_hkcu_aumid() {
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

/// Drop a Start menu shortcut at
/// `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Hindsight.lnk` with the
/// `System.AppUserModel.ID` property set to our AUMID. Windows Toast
/// notifications only attribute reliably to a desktop app when such a
/// shortcut exists — registry alone is not enough in many cases.
///
/// Always rewrites: cheap, and dev/production exes may be at different
/// paths between launches.
fn ensure_start_menu_shortcut() -> Result<(), Box<dyn std::error::Error>> {
    let exe_path = std::env::current_exe()?;
    let shortcut_path = start_menu_shortcut_path()?;

    if let Some(parent) = shortcut_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    unsafe {
        // STA — IShellLink + IPropertyStore require apartment-threaded COM.
        // Returns S_FALSE if COM was already initialized; we still need to
        // uninit on the way out to match init count.
        let init_result = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let needs_uninit = init_result.is_ok();

        let result = create_shortcut(&exe_path, &shortcut_path);

        if needs_uninit {
            CoUninitialize();
        }

        result?;
    }

    tracing::info!(path = %shortcut_path.display(), "AUMID start menu shortcut written");
    Ok(())
}

unsafe fn create_shortcut(
    exe_path: &Path,
    shortcut_path: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;

    // Target exe.
    let exe_wide = to_wide(exe_path.to_string_lossy().as_ref());
    link.SetPath(PCWSTR(exe_wide.as_ptr()))?;

    // Working directory = exe's folder.
    if let Some(dir) = exe_path.parent() {
        let dir_wide = to_wide(dir.to_string_lossy().as_ref());
        link.SetWorkingDirectory(PCWSTR(dir_wide.as_ptr()))?;
    }

    // Description (shows on shortcut hover).
    let desc_wide = to_wide(DISPLAY_NAME);
    link.SetDescription(PCWSTR(desc_wide.as_ptr()))?;

    // Icon — point at icon.ico if we can find it.
    if let Some(icon) = locate_icon() {
        let icon_wide = to_wide(&icon);
        link.SetIconLocation(PCWSTR(icon_wide.as_ptr()), 0)?;
    }

    // Set System.AppUserModel.ID on the shortcut. This is the property
    // Windows reads when attributing toast notifications.
    let store: IPropertyStore = link.cast()?;
    let pv = PROPVARIANT::from(AUMID);
    store.SetValue(&PKEY_APP_USER_MODEL_ID, &pv)?;
    store.Commit()?;

    // Persist to disk.
    let persist: IPersistFile = link.cast()?;
    let target_wide = to_wide(shortcut_path.to_string_lossy().as_ref());
    persist.Save(PCWSTR(target_wide.as_ptr()), true)?;

    Ok(())
}

fn start_menu_shortcut_path() -> Result<PathBuf, std::env::VarError> {
    let appdata = std::env::var("APPDATA")?;
    Ok(PathBuf::from(appdata)
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join(SHORTCUT_FILENAME))
}

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
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
