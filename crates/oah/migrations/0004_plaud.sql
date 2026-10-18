-- Browser handoff codes for Plaud sign-in. expires_at, completed_at are epoch milliseconds.
-- error holds the message of the last failed complete attempt; the code stays pending.
CREATE TABLE plaud_handoffs (
    code TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    completed_at INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX plaud_handoffs_user ON plaud_handoffs(user_id);
