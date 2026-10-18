-- Audio pipeline state. One row per pipeline job (jobs.kind = 'pipeline').
CREATE TABLE pipeline_runs (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    phase TEXT NOT NULL DEFAULT 'queued',   -- queued | decode | vad | transcribing | completed | needs_alignment | paused_disk | cancelled | failed
    updated_at INTEGER NOT NULL DEFAULT 0
);

-- The chunk plan is written once per job; later runs never move these positions.
CREATE TABLE pipeline_chunks (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    chunk_id TEXT NOT NULL,
    start_sample INTEGER NOT NULL,
    end_sample INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued',   -- queued | completed | failed
    attempts INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error_message TEXT,
    response TEXT,                          -- JSON of the provider transcript, completed chunks only
    PRIMARY KEY (job_id, idx)
);
