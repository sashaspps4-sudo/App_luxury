use aes_gcm::{aead::{Aead, AeadCore, KeyInit, OsRng, Payload}, Aes256Gcm, Nonce};

const HEADER: &[u8] = b"LuxuryMailer-macOS-v1\0";
const NONCE_LEN: usize = 12;

pub fn seal(value: &[u8], key: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "Некорректный ключ хранилища.".to_string())?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let encrypted = cipher.encrypt(&nonce, Payload { msg: value, aad: HEADER }).map_err(|_| "Не удалось зашифровать данные.".to_string())?;
    let mut result = HEADER.to_vec();
    result.extend_from_slice(&nonce);
    result.extend_from_slice(&encrypted);
    Ok(result)
}

pub fn open(value: &[u8], key: &[u8]) -> Result<Vec<u8>, String> {
    if !value.starts_with(HEADER) || value.len() < HEADER.len() + NONCE_LEN + 16 {
        return Err("Неподдерживаемый или повреждённый формат хранилища. Сессии Windows нельзя переносить на Mac.".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "Некорректный ключ хранилища.".to_string())?;
    let nonce = Nonce::from_slice(&value[HEADER.len()..HEADER.len() + NONCE_LEN]);
    cipher.decrypt(nonce, Payload { msg: &value[HEADER.len() + NONCE_LEN..], aad: HEADER }).map_err(|_| "Не удалось расшифровать данные: неверный ключ или файл повреждён.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_storage_roundtrip_and_authentication() {
        let key = [7; 32];
        let data = vec![42; 200_000];
        let first = seal(&data, &key).unwrap();
        let second = seal(&data, &key).unwrap();
        assert_ne!(first, second);
        assert_eq!(open(&first, &key).unwrap(), data);
        assert!(open(&first, &[8; 32]).is_err());
        let mut damaged = first.clone();
        *damaged.last_mut().unwrap() ^= 1;
        assert!(open(&damaged, &key).is_err());
        for invalid in [&b"plain secret"[..], &first[..HEADER.len()], &first[1..]] { assert!(open(invalid, &key).is_err()); }
    }
}
