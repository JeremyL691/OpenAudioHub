use rand::Rng;

const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/// A 21-character URL-safe random id (URL-safe alphabet, 21 characters).
pub fn new_id() -> String {
    let mut rng = rand::rng();
    (0..21)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect()
}

/// A random hex token of `bytes` bytes.
pub fn token_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::rng().fill(buf.as_mut_slice());
    hex::encode(buf)
}

#[cfg(test)]
mod tests {
    #[test]
    fn id_shape() {
        let id = super::new_id();
        assert_eq!(id.len(), 21);
        assert!(id.bytes().all(|b| super::ALPHABET.contains(&b)));
        assert_ne!(id, super::new_id());
    }
}
