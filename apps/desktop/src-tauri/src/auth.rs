// Device-token storage backed by a file in the app data directory.
//
// Originally this used the OS credential store (Wincred / Keychain) via the
// `keyring` crate, but Keychain entries are scoped to the calling app's
// code-signing identity. Unsigned/ad-hoc-signed builds get a different
// identity across launches, so `get_password()` returns `NoEntry` on the
// second launch and the user is silently signed out. Until proper Developer
// ID signing is in place, we store the token plaintext in the per-user
// app data dir (`~/Library/Application Support/...` on macOS,
// `%APPDATA%\...` on Windows) with 0600 perms on Unix.
//
// The plaintext token is also held in a small in-memory cache so that hot
// paths (every API request) don't repeatedly hit the disk.

use std::path::{Path, PathBuf};

use parking_lot::Mutex;

pub struct DeviceTokenStore {
    path: PathBuf,
    cache: Mutex<Option<String>>,
}

impl DeviceTokenStore {
    pub fn load(path: PathBuf) -> Self {
        let cache = Mutex::new(read_token_file(&path));
        Self { path, cache }
    }

    pub fn get(&self) -> Option<String> {
        self.cache.lock().clone()
    }

    pub fn set(&self, token: String) -> std::io::Result<()> {
        write_token_file(&self.path, &token)?;
        *self.cache.lock() = Some(token);
        Ok(())
    }

    pub fn clear(&self) -> std::io::Result<()> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        *self.cache.lock() = None;
        Ok(())
    }
}

fn read_token_file(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn write_token_file(path: &Path, token: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, token)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // 0600 — readable/writable only by the owning user. The directory
        // itself is already user-scoped, but this is cheap belt-and-braces.
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}
