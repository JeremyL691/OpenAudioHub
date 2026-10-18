//! Field encryption and password hashing.

use aes_gcm::aead::consts::U16;
use aes_gcm::aead::{AeadInOut, KeyInit};
use aes_gcm::aes::Aes256;
use aes_gcm::{AesGcm, Nonce, Tag};
use argon2::Argon2;
use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use rand::RngCore;
use serde_json::Value;
use subtle::ConstantTimeEq;
use unicode_normalization::UnicodeNormalization;

// 16-byte nonce, the size used by the stored ciphertext format.
type Cipher = AesGcm<Aes256, U16>;

const PREFIX: &str = "v1:";

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct CryptoError(&'static str);

/// The instance's content key (`ENCRYPTION_KEY`).
#[derive(Clone)]
pub struct FieldKey(Cipher);

impl FieldKey {
    pub fn from_hex(key_hex: &str) -> Result<Self, CryptoError> {
        let key = hex::decode(key_hex).map_err(|_| CryptoError("ENCRYPTION_KEY is not hex"))?;
        Cipher::new_from_slice(&key)
            .map(Self)
            .map_err(|_| CryptoError("ENCRYPTION_KEY must be 32 bytes (64 hex characters)"))
    }

    /// Encrypts to `v1:<iv>:<tag>:<ciphertext>` (lowercase hex).
    pub fn encrypt(&self, plaintext: &str) -> String {
        let mut iv = [0u8; 16];
        rand::rng().fill_bytes(&mut iv);
        let mut buf = plaintext.as_bytes().to_vec();
        let nonce = Nonce::<U16>::from(iv);
        let tag = self
            .0
            .encrypt_inout_detached(&nonce, b"", buf.as_mut_slice().into())
            .expect("AES-GCM encryption of an in-memory buffer cannot fail");
        format!(
            "{PREFIX}{}:{}:{}",
            hex::encode(iv),
            hex::encode(tag),
            hex::encode(buf)
        )
    }

    /// Decrypts a text column. Values without the `v1:` prefix are returned unchanged, while a value
    /// that carries the prefix but is not well formed is rejected.
    pub fn decrypt(&self, value: &str) -> Result<String, CryptoError> {
        let Some([iv, tag, ct]) = cipher_parts(value) else {
            return match value.strip_prefix(PREFIX) {
                Some(_) => Err(CryptoError("malformed ciphertext")),
                None => Ok(value.to_owned()),
            };
        };
        let iv = hex::decode(iv).map_err(|_| CryptoError("bad iv"))?;
        let tag = hex::decode(tag).map_err(|_| CryptoError("bad tag"))?;
        let mut buf = hex::decode(ct).map_err(|_| CryptoError("bad ciphertext"))?;
        let nonce = Nonce::<U16>::try_from(iv.as_slice()).map_err(|_| CryptoError("bad iv"))?;
        let tag = Tag::<U16>::try_from(tag.as_slice()).map_err(|_| CryptoError("bad tag"))?;
        self.0
            .decrypt_inout_detached(&nonce, b"", buf.as_mut_slice().into(), &tag)
            .map_err(|_| CryptoError("decryption failed"))?;
        String::from_utf8(buf).map_err(|_| CryptoError("plaintext is not UTF-8"))
    }

    /// Encrypts a JSON value into the `{"c": "v1:..."}` envelope.
    pub fn encrypt_json(&self, value: &Value) -> Value {
        serde_json::json!({ "c": self.encrypt(&value.to_string()) })
    }

    /// Opens a `{"c": ...}` envelope. Other JSON values are returned unchanged, while an envelope
    /// whose string carries the `v1:` prefix but is not well formed is rejected.
    pub fn decrypt_json(&self, value: &Value) -> Result<Value, CryptoError> {
        let Some(c) = value.get("c").and_then(Value::as_str) else {
            return Ok(value.clone());
        };
        if cipher_parts(c).is_none() {
            return match c.strip_prefix(PREFIX) {
                Some(_) => Err(CryptoError("malformed ciphertext")),
                None => Ok(value.clone()),
            };
        }
        serde_json::from_str(&self.decrypt(c)?)
            .map_err(|_| CryptoError("decrypted field is not JSON"))
    }
}

/// Splits `[v1:]<32 hex>:<32 hex>:<even hex>` into its three parts.
fn cipher_parts(value: &str) -> Option<[&str; 3]> {
    let body = value.strip_prefix(PREFIX).unwrap_or(value);
    let mut it = body.split(':');
    let parts = [it.next()?, it.next()?, it.next()?];
    let hex = |s: &str| {
        s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    let ok = it.next().is_none()
        && parts[0].len() == 32
        && parts[1].len() == 32
        && parts[2].len() % 2 == 0
        && parts.iter().all(|p| hex(p));
    ok.then_some(parts)
}

fn nfkc(password: &str) -> String {
    password.nfkc().collect()
}

pub fn hash_password(password: &str) -> String {
    Argon2::default()
        .hash_password(nfkc(password).as_bytes())
        .expect("argon2 with default parameters cannot fail")
        .to_string()
}

/// Checks a password against an argon2id hash or a scrypt hash in the `<salt hex>:<key hex>` format.
pub fn verify_password(hash: &str, password: &str) -> bool {
    if hash.starts_with("$argon2") {
        return PasswordHash::new(hash)
            .map(|h| {
                Argon2::default()
                    .verify_password(nfkc(password).as_bytes(), &h)
                    .is_ok()
            })
            .unwrap_or(false);
    }
    verify_scrypt_password(hash, password)
}

/// True for hashes that should be replaced with argon2id after a successful sign-in.
pub fn needs_rehash(hash: &str) -> bool {
    !hash.starts_with("$argon2id$")
}

/// Scrypt format `<salt hex>:<key hex>`: N=16384 r=16 p=1, 64-byte key,
/// and the salt is the hex text itself, not its decoded bytes.
fn verify_scrypt_password(hash: &str, password: &str) -> bool {
    let Some((salt, key_hex)) = hash.split_once(':') else {
        return false;
    };
    let Ok(expected) = hex::decode(key_hex) else {
        return false;
    };
    if salt.len() != 32 || expected.len() != 64 {
        return false;
    }
    let params = scrypt::Params::new(14, 16, 1).expect("fixed scrypt parameters are valid");
    let mut derived = [0u8; 64];
    if scrypt::scrypt(
        nfkc(password).as_bytes(),
        salt.as_bytes(),
        &params,
        &mut derived,
    )
    .is_err()
    {
        return false;
    }
    derived.ct_eq(&expected).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    #[test]
    fn text_round_trip_and_passthrough() {
        let key = FieldKey::from_hex(KEY).unwrap();
        let sealed = key.encrypt("héllo 世界");
        assert!(sealed.starts_with("v1:"));
        assert_eq!(key.decrypt(&sealed).unwrap(), "héllo 世界");
        assert_eq!(key.decrypt("plain title").unwrap(), "plain title");
        assert_eq!(key.decrypt(&key.encrypt("")).unwrap(), "");
    }

    #[test]
    fn tampering_is_an_error() {
        let key = FieldKey::from_hex(KEY).unwrap();
        let sealed = key.encrypt("secret");
        let mut bad = sealed.into_bytes();
        let last = bad.len() - 1;
        bad[last] = if bad[last] == b'0' { b'1' } else { b'0' };
        assert!(key.decrypt(std::str::from_utf8(&bad).unwrap()).is_err());
    }

    #[test]
    fn json_envelope_round_trip() {
        let key = FieldKey::from_hex(KEY).unwrap();
        let value = serde_json::json!(["a", "b"]);
        let sealed = key.encrypt_json(&value);
        assert_eq!(key.decrypt_json(&sealed).unwrap(), value);
        assert_eq!(key.decrypt_json(&value).unwrap(), value);
    }

    #[test]
    fn malformed_ciphertext_is_rejected() {
        let key = FieldKey::from_hex(KEY).unwrap();
        for bad in ["v1:not-hex", "v1:00:11:22"] {
            assert!(key.decrypt(bad).is_err(), "{bad} should not decode");
            assert!(
                key.decrypt_json(&serde_json::json!({ "c": bad })).is_err(),
                "{bad} should not open as an envelope"
            );
        }
        assert_eq!(key.decrypt("plain title").unwrap(), "plain title");
        let plain = serde_json::json!({ "c": "plain" });
        assert_eq!(key.decrypt_json(&plain).unwrap(), plain);
    }

    #[test]
    fn passwords() {
        let hash = hash_password("pässwörd 密码");
        assert!(verify_password(&hash, "pässwörd 密码"));
        assert!(!verify_password(&hash, "wrong"));
        assert!(!needs_rehash(&hash));
        // Scrypt hash of the password "ﬁ" (NFKC folds it to "fi").
        let scrypt_hash = include_str!("../tests/fixtures/scrypt-hash.txt").trim();
        assert!(verify_password(scrypt_hash, "fi"));
        assert!(needs_rehash(scrypt_hash));
    }
}
