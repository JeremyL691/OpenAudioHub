-- An automatic summary is keyed per transcript, so a recording that was transcribed again keeps a
-- run for each version instead of reusing the older version's queued job. Jobs that carry a key
-- are therefore not covered by the one-active-job-per-recording rule: the key is what has to be
-- unique for them. Manual runs carry no key and keep the rule.
DROP INDEX jobs_one_active;
CREATE UNIQUE INDEX jobs_one_active ON jobs(kind, recording_id)
    WHERE state IN ('queued', 'running') AND recording_id IS NOT NULL AND dedupe_key IS NULL;

-- A webhook delivery may be registered with a stable key, so the transaction that saves a
-- transcript records its completion event once even when the save is repeated.
ALTER TABLE webhook_deliveries ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX webhook_deliveries_dedupe ON webhook_deliveries(dedupe_key)
    WHERE dedupe_key IS NOT NULL;
