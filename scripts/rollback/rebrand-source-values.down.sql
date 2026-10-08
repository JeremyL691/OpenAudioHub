-- Reverses 0041_rebrand_source_values and 0043_source_default_openaudiohub. Run by hand against the database; it is
-- not wired into the migrator. The 'riffado-included' provider pointer cleared by
-- 0041 cannot be restored: that provider no longer exists (Mynah was removed).
UPDATE "transcriptions" SET "source" = 'riffado' WHERE "source" = 'openaudiohub';
UPDATE "ai_enhancements" SET "source" = 'riffado' WHERE "source" = 'openaudiohub';
UPDATE "user_settings" SET "preferred_transcript_source" = 'riffado' WHERE "preferred_transcript_source" = 'openaudiohub';
ALTER TABLE "transcriptions" ALTER COLUMN "source" SET DEFAULT 'riffado';
ALTER TABLE "ai_enhancements" ALTER COLUMN "source" SET DEFAULT 'riffado';
