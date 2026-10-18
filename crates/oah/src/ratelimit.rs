//! Fixed-window request counters kept in memory.
//! shortcut: counters reset on restart and are per process; fine for the single-node server.

use std::collections::HashMap;
use std::sync::Mutex;

pub struct RateLimiter {
    buckets: Mutex<HashMap<String, (u32, i64)>>,
    hits: std::sync::atomic::AtomicU32,
}

/// Outcome of one counted request.
pub struct Decision {
    pub allowed: bool,
    pub limit: u32,
    pub remaining: u32,
    /// Unix milliseconds when the window resets.
    pub reset_at: i64,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self {
            buckets: Mutex::new(HashMap::new()),
            hits: Default::default(),
        }
    }
}

impl RateLimiter {
    /// Counts one request for `key` against `limit` per `window_ms`.
    pub fn hit(&self, key: &str, limit: u32, window_ms: i64, now: i64) -> Decision {
        let mut buckets = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        // Drop finished windows now and then, so the map does not grow without bound.
        if self.hits.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % 1000 == 999 {
            buckets.retain(|_, (_, reset)| *reset > now);
        }
        let entry = buckets
            .entry(key.to_owned())
            .or_insert((0, now + window_ms));
        if entry.1 <= now {
            *entry = (0, now + window_ms);
        }
        entry.0 = entry.0.saturating_add(1);
        Decision {
            allowed: entry.0 <= limit,
            limit,
            remaining: limit.saturating_sub(entry.0),
            reset_at: entry.1,
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn window_counts_and_resets() {
        let rl = super::RateLimiter::default();
        assert!(rl.hit("k", 2, 1000, 0).allowed);
        assert!(rl.hit("k", 2, 1000, 10).allowed);
        let third = rl.hit("k", 2, 1000, 20);
        assert!(!third.allowed);
        assert_eq!(third.reset_at, 1000);
        assert!(rl.hit("other", 2, 1000, 20).allowed);
        assert!(rl.hit("k", 2, 1000, 1000).allowed);
    }
}
