-- Identifies the transcript a follow-up job was queued for. A recording can be transcribed more
-- than once, and a job queued for an older transcript must not title or summarise the newer one,
-- so the transcript is part of the job's identity rather than something it looks up when it runs.
--
-- `dedupe_key` also lets a follow-up job be enqueued inside the transaction that saves the
-- transcript: the unique index below rejects a second job for the same transcript, including
-- after it finished, so a retried save cannot queue the same work twice.
ALTER TABLE jobs ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX jobs_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- A follow-up job belongs to one transcript, and a recording can be transcribed again while an
-- older transcript's follow-up is still queued. The one-active-job-per-recording rule therefore
-- does not apply to this kind: `dedupe_key` keeps the per-transcript uniqueness that matters.
-- The rule is rebuilt rather than dropped, so every other kind keeps it.
DROP INDEX jobs_one_active;
CREATE UNIQUE INDEX jobs_one_active ON jobs(kind, recording_id)
    WHERE state IN ('queued', 'running') AND recording_id IS NOT NULL AND kind <> 'after_transcript';
