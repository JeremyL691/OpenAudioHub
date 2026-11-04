CREATE TABLE IF NOT EXISTS zip_imports (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    zip_sha256   TEXT NOT NULL,
    zip_filename TEXT NOT NULL,
    recording_id TEXT REFERENCES recordings(id) ON DELETE SET NULL,
    export_path  TEXT,
    created_at   INTEGER NOT NULL,
    UNIQUE(user_id, zip_sha256)
);
CREATE INDEX IF NOT EXISTS idx_zip_imports_user_created
    ON zip_imports(user_id, created_at DESC);
