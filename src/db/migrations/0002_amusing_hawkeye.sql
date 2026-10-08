ALTER TABLE "transcriptions" ADD COLUMN "detected_language" varchar(10);--> statement-breakpoint
ALTER TABLE "transcriptions" ADD COLUMN "transcription_type" varchar(10) DEFAULT 'server' NOT NULL;--> statement-breakpoint
ALTER TABLE "transcriptions" DROP COLUMN IF EXISTS "language";