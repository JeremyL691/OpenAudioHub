-- Where a recording's title came from, so a sync update follows Plaud's name only
-- while the title is still the original one. Rows that predate this column keep
-- 'unknown', which sync treats as a local title and never overwrites.
ALTER TABLE recordings ADD COLUMN title_source TEXT NOT NULL DEFAULT 'unknown';
CREATE INDEX recordings_title_source ON recordings(user_id, title_source);

-- Auto export covers a recording only when it was first added while auto export
-- was on. Rows that existed before this migration stay at 0 and are never exported.
ALTER TABLE recordings ADD COLUMN auto_export_eligible INTEGER NOT NULL DEFAULT 0;
-- Target reserved for an export that is being written. A restart adopts the file
-- at this path instead of writing a second copy. Encrypted at rest like auto_export_path.
ALTER TABLE recordings ADD COLUMN auto_export_target TEXT;
-- Failed writes per recording. After three the row stops being retried.
ALTER TABLE recordings ADD COLUMN auto_export_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX recordings_auto_export_pending ON recordings(user_id, created_at)
    WHERE auto_export_eligible = 1 AND auto_export_path IS NULL;

-- A summary counts as present only when it has text, key points or action items.
-- Rows written before this column keep the previous meaning, which was "summary text
-- is not null"; rows written after it are set by the writer.
ALTER TABLE ai_enhancements ADD COLUMN has_content INTEGER NOT NULL DEFAULT 1;
CREATE INDEX ai_enhancements_content ON ai_enhancements(user_id, has_content);

-- The eligibility column replaces the "new recordings from now" window.
DROP TABLE auto_export_state;
-- The folder and format the last export pass used. A change resets the retry count.
CREATE TABLE auto_export_run (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    signature TEXT NOT NULL
);
