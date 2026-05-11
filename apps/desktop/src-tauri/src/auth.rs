// Device-token storage backed by the OS credential store.
//
// On Windows: Credential Manager (Wincred) via the `keyring` crate.
// On macOS:   Keychain (when the macOS port lands in Plan 09).
//
// The plaintext token is held in a small in-memory cache so that hot paths
// (every API request) don't repeatedly hit the OS credential store.

use parking_lot::Mutex;

const SERVICE: &str = "app.hindsight.desktop";
const ACCOUNT: &str = "device_token";

pub struct DeviceTokenStore {
    entry: keyring::Entry,
    cache: Mutex<Option<String>>,
}

impl DeviceTokenStore {
    pub fn load() -> Self {
        let entry = keyring::Entry::new(SERVICE, ACCOUNT).expect("keyring entry");
        let cache = Mutex::new(entry.get_password().ok());
        Self { entry, cache }
    }

    pub fn get(&self) -> Option<String> {
        self.cache.lock().clone()
    }

    pub fn set(&self, token: String) -> keyring::Result<()> {
        self.entry.set_password(&token)?;
        *self.cache.lock() = Some(token);
        Ok(())
    }

    pub fn clear(&self) -> keyring::Result<()> {
        // delete_credential() returns NoEntry if there's nothing to clear;
        // normalize that to Ok so calling clear() on a fresh install is fine.
        match self.entry.delete_credential() {
            Ok(()) => {}
            Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(e),
        }
        *self.cache.lock() = None;
        Ok(())
    }
}
