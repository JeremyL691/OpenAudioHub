-- Snapshot resync only (B-002, D-202). Every change drizzle-kit found here was
-- already applied by an earlier migration whose meta snapshot was never
-- regenerated upstream: the stripe_webhook_events inbox (0036) and the
-- user_settings columns auto_summarize, auto_summarize_preset (0038),
-- speaker_diarization, diarization_speaker_count (0037). Re-running them would
-- fail on every existing database, so this migration does nothing. Its purpose
-- is the regenerated meta/0042_snapshot.json, which matches schema.ts again.
SELECT 1;
