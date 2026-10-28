-- A browser extension that connected Plaud keeps the connection fresh with a refresh key. Only the
-- key's SHA-256 is stored. A key can only replace the Plaud token of its own user.
CREATE TABLE plaud_refresh_keys (
    key_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
);
CREATE INDEX plaud_refresh_keys_user ON plaud_refresh_keys(user_id, created_at);
