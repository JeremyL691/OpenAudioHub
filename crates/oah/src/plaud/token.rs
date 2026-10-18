//! Plaud hosts, the API base check, and token claims. Tokens are read, never verified.

use serde_json::Value;

pub const GLOBAL_BASE: &str = "https://api.plaud.ai";

const REGIONS: [(&str, &str); 4] = [
    ("global", GLOBAL_BASE),
    ("eu", "https://api-euc1.plaud.ai"),
    ("apse1", "https://api-apse1.plaud.ai"),
    ("cn", "https://api.plaud.cn"),
];

/// The region key for a stored base, or `custom`.
pub fn server_key(base: &str) -> &'static str {
    REGIONS
        .iter()
        .find(|(_, b)| *b == base)
        .map_or("custom", |&(key, _)| key)
}

/// Trims spaces and trailing slashes.
pub fn normalize(raw: &str) -> String {
    raw.trim().trim_end_matches('/').to_owned()
}

/// The base to store, or `None` when it is not allowed. Plaud hosts must be https with no path.
/// `override_base` (the test override, `OAH_PLAUD_API_BASE`) is accepted with its own scheme and paths.
pub fn allowed_base(override_base: Option<&str>, raw: &str) -> Option<String> {
    let base = normalize(raw);
    if override_base.is_some_and(|origin| base == origin || base.starts_with(&format!("{origin}/")))
    {
        return Some(base);
    }
    let host = base.strip_prefix("https://")?.to_ascii_lowercase();
    if host.contains(['/', '@', ':', '?', '#', ' ']) {
        return None;
    }
    let ok = ["plaud.ai", "plaud.cn"]
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")));
    ok.then(|| format!("https://{host}"))
}

/// The claims in a token's middle part, read without checking the signature.
pub fn claims(token: &str) -> Option<Value> {
    let part = token.split('.').nth(1)?;
    serde_json::from_slice(&b64url_decode(part)?).ok()
}

/// Workspace tokens carry `ut_ref` or `wid`; account tokens do not.
pub fn is_workspace(claims: &Value) -> bool {
    claims.get("ut_ref").is_some() || claims.get("wid").is_some()
}

/// The expiry claim in Unix milliseconds.
pub fn expires_at_ms(claims: &Value) -> Option<i64> {
    claims.get("exp")?.as_i64()?.checked_mul(1000)
}

pub fn b64url_decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in input.bytes().filter(|&c| c != b'=') {
        let v = u32::from(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        });
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

pub fn b64url_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let mut b = [0u8; 3];
        b[..chunk.len()].copy_from_slice(chunk);
        let v = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..=chunk.len() {
            out.push(ALPHABET[((v >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_are_plaud_https_only() {
        assert_eq!(
            allowed_base(None, "https://api-euc1.plaud.ai/"),
            Some("https://api-euc1.plaud.ai".into())
        );
        assert_eq!(
            allowed_base(None, " https://api.plaud.cn "),
            Some("https://api.plaud.cn".into())
        );
        assert_eq!(
            allowed_base(None, "https://plaud.ai"),
            Some("https://plaud.ai".into())
        );
        assert_eq!(allowed_base(None, "https://example.com"), None);
        assert_eq!(allowed_base(None, "http://api.plaud.ai"), None);
        assert_eq!(
            allowed_base(None, "https://api.plaud.ai.evil.example"),
            None
        );
        assert_eq!(allowed_base(None, "https://api.plaud.ai/path"), None);
        assert_eq!(allowed_base(None, "https://evilplaud.ai"), None);
    }

    #[test]
    fn override_origin_is_accepted_over_plain_http() {
        let o = Some("http://127.0.0.1:3298");
        assert_eq!(
            allowed_base(o, "http://127.0.0.1:3298/"),
            Some("http://127.0.0.1:3298".into())
        );
        assert_eq!(
            allowed_base(o, "http://127.0.0.1:3298/eu"),
            Some("http://127.0.0.1:3298/eu".into())
        );
        assert_eq!(allowed_base(o, "http://127.0.0.1:9999"), None);
    }

    #[test]
    fn regions_map_to_keys() {
        assert_eq!(server_key("https://api.plaud.ai"), "global");
        assert_eq!(server_key("https://api-apse1.plaud.ai"), "apse1");
        assert_eq!(server_key("https://api.plaud.cn"), "cn");
        assert_eq!(server_key("http://127.0.0.1:3298"), "custom");
    }

    #[test]
    fn claims_are_read_without_checking_the_signature() {
        let payload = b64url_encode(br#"{"exp":1700000000,"wid":"ws-1"}"#.as_slice());
        let token = format!("aGVhZGVy.{payload}.c2ln");
        let c = claims(&token).expect("claims");
        assert!(is_workspace(&c));
        assert_eq!(expires_at_ms(&c), Some(1_700_000_000_000));
        assert!(claims("no-dots").is_none());
    }

    #[test]
    fn base64url_round_trips() {
        let bytes: Vec<u8> = (0..32u8).map(|i| i.wrapping_mul(37)).collect();
        let text = b64url_encode(&bytes);
        assert_eq!(text.len(), 43);
        assert_eq!(b64url_decode(&text), Some(bytes));
        assert_eq!(b64url_decode("ab$"), None);
    }
}
