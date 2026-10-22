-- Ask AI over a recording's transcript (spec/recording-chat.md). One conversation per recording and
-- user. Questions, answers, quoted text and any stored intermediate note are encrypted; only the
-- routing and status columns are plain.
--
-- `generation` is the conversation's own fence. Clearing the chat or deleting the recording moves
-- it forward, so a run started under an older generation cannot save anything afterwards.

CREATE TABLE recording_chats (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL DEFAULT 0,
    -- Preference for the next send: a saved provider row, and the model and effort chosen on it.
    provider_id TEXT,
    provider TEXT,
    model TEXT,
    reasoning TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (recording_id, user_id)
);

CREATE TABLE recording_chat_turns (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES recording_chats(id) ON DELETE CASCADE,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Client-supplied, so a repeated submit is answered with the turn it already created.
    request_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    -- pending | running | completed | failed | cancelled | interrupted | stale
    status TEXT NOT NULL,
    generation INTEGER NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    -- The turn this one retries, when the user asked again after a failure or a stop.
    retry_of TEXT,
    question TEXT NOT NULL,                -- encrypted
    answer TEXT,                           -- encrypted, partial while the run is going
    citations TEXT,                        -- JSON envelope, encrypted
    revision TEXT NOT NULL,
    transcript_id TEXT,
    provider TEXT,
    model TEXT,
    reasoning_requested TEXT,
    reasoning_sent TEXT,
    -- 1 when the model's supported effort set was known, so the interface can tell "not supported"
    -- apart from "not known".
    reasoning_known INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error_message TEXT,
    lease_owner TEXT,
    lease_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER,
    UNIQUE (chat_id, request_id)
);

-- One answer at a time per conversation.
CREATE UNIQUE INDEX recording_chat_turns_active ON recording_chat_turns(chat_id)
    WHERE status IN ('pending', 'running');
CREATE INDEX recording_chat_turns_seq ON recording_chat_turns(chat_id, seq);

-- The transcript split into retrievable pieces, kept encrypted. Rows are derived from one
-- transcript revision and are replaced when that revision changes.
CREATE TABLE recording_chat_chunks (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    revision TEXT NOT NULL,
    chunker INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    body TEXT NOT NULL,                    -- encrypted
    start_char INTEGER NOT NULL,
    end_char INTEGER NOT NULL,
    start_ms INTEGER,
    end_ms INTEGER,
    timeline_source TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (recording_id, user_id, revision, ordinal)
);
