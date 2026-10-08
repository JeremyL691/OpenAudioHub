UPDATE "transcriptions" SET "source" = 'openaudiohub' WHERE "source" = 'riffado';--> statement-breakpoint
UPDATE "ai_enhancements" SET "source" = 'openaudiohub' WHERE "source" = 'riffado';--> statement-breakpoint
UPDATE "user_settings" SET "preferred_transcript_source" = 'openaudiohub' WHERE "preferred_transcript_source" = 'riffado';--> statement-breakpoint
UPDATE "user_settings" SET "default_transcription_provider_id" = NULL WHERE "default_transcription_provider_id" = 'riffado-included';
