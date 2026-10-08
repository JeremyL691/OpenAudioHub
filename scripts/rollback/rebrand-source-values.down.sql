-- Reverses 0041_rebrand_source_values. Run by hand against the database; it is
-- not wired into the migrator. The 'riffado-included' provider pointer cleared by
-- 0041 cannot be restored: that provider no longer exists (Mynah removed, D-023).
UPDATE "transcriptions" SET "source" = 'riffado' WHERE "source" = 'openaudiohub';
UPDATE "ai_enhancements" SET "source" = 'riffado' WHERE "source" = 'openaudiohub';
UPDATE "user_settings" SET "preferred_transcript_source" = 'riffado' WHERE "preferred_transcript_source" = 'openaudiohub';
