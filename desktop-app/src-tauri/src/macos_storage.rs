use aes_gcm::{aead::{KeyInit, OsRng}, Aes256Gcm};
use security_framework::passwords::{generic_password, PasswordOptions};
use std::sync::Mutex;

const SERVICE: &str = "com.luxury.mailer";
const ACCOUNT: &str = "encrypted-storage-master-v1";
static KEY_LOCK: Mutex<()> = Mutex::new(());

// Add-only, rather than upsert: another app process must never replace the
// master key while older files still depend on it.
#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecKeychainAddGenericPassword(keychain: *const std::ffi::c_void, service_len: u32, service: *const u8, account_len: u32, account: *const u8, password_len: u32, password: *const u8, item: *mut *const std::ffi::c_void) -> i32;
}

fn load_key(create: bool) -> Result<Vec<u8>, String> {
    let _guard = KEY_LOCK.lock().map_err(|e| e.to_string())?;
    let read = || generic_password(PasswordOptions::new_generic_password(SERVICE, ACCOUNT));
    match read() {
        Ok(key) if key.len() == 32 => return Ok(key),
        Ok(_) => return Err("Ключ в macOS Keychain повреждён; автоматическая замена запрещена.".into()),
        Err(error) if error.code() == -25300 && create => (),
        Err(error) => return Err(format!("Не удалось получить ключ из macOS Keychain: {error}")),
    }
    let key = Aes256Gcm::generate_key(OsRng);
    let status = unsafe { SecKeychainAddGenericPassword(std::ptr::null(), SERVICE.len() as u32, SERVICE.as_ptr(), ACCOUNT.len() as u32, ACCOUNT.as_ptr(), key.len() as u32, key.as_ptr(), std::ptr::null_mut()) };
    if status != 0 && status != -25299 { return Err(format!("Не удалось создать ключ в macOS Keychain: {status}")); }
    let stored = read().map_err(|error| format!("Не удалось прочитать ключ из macOS Keychain: {error}"))?;
    if stored.len() != 32 { return Err("Некорректный ключ macOS Keychain.".into()); }
    Ok(stored)
}

pub fn protect(value: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    let key = load_key(encrypt)?;
    if encrypt { super::sealed_storage::seal(value, &key) } else { super::sealed_storage::open(value, &key) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Requires an unlocked macOS login Keychain; run on a Mac before release"]
    fn keychain_persists_one_key_and_roundtrips() {
        assert_eq!(load_key(true).unwrap(), load_key(false).unwrap());
        let ciphertext = protect(b"macOS session secret", true).unwrap();
        assert_eq!(protect(&ciphertext, false).unwrap(), b"macOS session secret");
    }
}
