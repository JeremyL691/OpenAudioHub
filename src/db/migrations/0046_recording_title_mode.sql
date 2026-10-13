ALTER TABLE "user_settings" ADD COLUMN "recording_title_mode" varchar(20) DEFAULT 'ai' NOT NULL;--> statement-breakpoint
UPDATE "user_settings" SET "recording_title_mode" = 'original' WHERE "auto_generate_title" = false;
