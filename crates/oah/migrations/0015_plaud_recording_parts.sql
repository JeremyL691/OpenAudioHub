CREATE TABLE IF NOT EXISTS plaud_recording_parts (
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plaud_file_id     TEXT NOT NULL,
    recording_id      TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    part_index        INTEGER NOT NULL,
    start_time        INTEGER NOT NULL,
    end_time          INTEGER NOT NULL,
    plaud_duration_ms INTEGER NOT NULL,
    audio_duration_ms INTEGER NOT NULL,
    plaud_version     TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    PRIMARY KEY (user_id, plaud_file_id),
    UNIQUE (recording_id, part_index)
);

CREATE TABLE IF NOT EXISTS plaud_split_settle (
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plaud_file_id TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, plaud_file_id)
);
