-- Times are integer milliseconds since the Unix epoch (UTC).
-- Columns marked "encrypted" hold `v1:<iv>:<tag>:<ciphertext>` (or a {"c": ...} JSON envelope).

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    name TEXT,
    suspended_at INTEGER,
    suspended_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Email and password sign-in. Hash is argon2id; a scrypt hash is upgraded on the next sign-in.
CREATE TABLE credentials (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    password_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- id is the SHA-256 (hex) of the session token; the token itself is never stored.
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- One-time tokens (password reset, email verification). value is a SHA-256 hex.
CREATE TABLE verifications (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE recordings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_sn TEXT NOT NULL,
    plaud_file_id TEXT NOT NULL,
    filename TEXT NOT NULL,                -- encrypted
    duration INTEGER NOT NULL,             -- milliseconds
    start_time INTEGER NOT NULL,
    end_time INTEGER NOT NULL,
    filesize INTEGER NOT NULL,
    file_md5 TEXT NOT NULL,
    storage_type TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    auto_export_path TEXT,
    downloaded_at INTEGER,
    plaud_version TEXT NOT NULL,
    timezone INTEGER,
    zonemins INTEGER,
    scene INTEGER,
    is_trash INTEGER NOT NULL DEFAULT 0,
    waveform_peaks TEXT,                   -- JSON
    deleted_at INTEGER,                    -- deleted locally; sync must not bring it back
    starred_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, plaud_file_id)
);
CREATE INDEX recordings_user_start ON recordings(user_id, start_time DESC, id DESC);

CREATE TABLE transcriptions (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,                    -- encrypted
    detected_language TEXT,
    transcription_type TEXT NOT NULL DEFAULT 'server',
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    timeline TEXT,                         -- JSON
    timeline_source TEXT,
    source TEXT NOT NULL DEFAULT 'openaudiohub',
    created_at INTEGER NOT NULL,
    UNIQUE (recording_id, user_id, source)
);

CREATE TABLE ai_enhancements (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    summary TEXT,                          -- encrypted
    action_items TEXT,                     -- JSON, encrypted envelope
    key_points TEXT,                       -- JSON, encrypted envelope
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'openaudiohub',
    prompt_id TEXT,
    language TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (recording_id, user_id)
);

-- AI provider credentials.
CREATE TABLE api_credentials (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    api_key TEXT NOT NULL,                 -- encrypted
    base_url TEXT,
    default_model TEXT,
    is_default_transcription INTEGER NOT NULL DEFAULT 0,
    is_default_enhancement INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX api_credentials_user ON api_credentials(user_id);

-- Keys for the public /api/v1 API.
CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    scopes TEXT NOT NULL DEFAULT '["read"]', -- JSON
    last_used_at INTEGER,
    expires_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- All user settings as one JSON object keyed by the API field names.
-- Defaults live in code, so a missing key means "default".
CREATE TABLE user_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
);

CREATE TABLE plaud_connections (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    bearer_token TEXT NOT NULL,            -- encrypted
    api_base TEXT NOT NULL DEFAULT 'https://api.plaud.ai',
    plaud_email TEXT,
    workspace_id TEXT,
    invalidated_at INTEGER,
    last_sync INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE plaud_devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    serial_number TEXT NOT NULL,
    name TEXT NOT NULL,
    model TEXT NOT NULL,
    version_number INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, serial_number)
);

CREATE TABLE export_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    kind TEXT NOT NULL DEFAULT 'manual',
    storage_key TEXT,
    file_size INTEGER,
    recording_count INTEGER,
    error_message TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    expires_at INTEGER
);
CREATE INDEX export_jobs_user ON export_jobs(user_id, created_at DESC);

-- Generic background work queue (transcription, pipeline, summaries, ...).
-- A worker claims a row by setting lease_until; an expired lease means the
-- worker died and the job can be claimed again.
CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    recording_id TEXT REFERENCES recordings(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | failed | cancelled
    payload TEXT NOT NULL DEFAULT '{}',    -- JSON
    progress REAL NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    run_after INTEGER NOT NULL,
    lease_until INTEGER,
    error_code TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER
);
CREATE INDEX jobs_claim ON jobs(state, run_after);
CREATE INDEX jobs_recording ON jobs(recording_id, kind);
-- At most one active job of a kind per recording (enqueue relies on this).
CREATE UNIQUE INDEX jobs_one_active ON jobs(kind, recording_id) WHERE state IN ('queued', 'running') AND recording_id IS NOT NULL;

