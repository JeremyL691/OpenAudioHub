ALTER TABLE "export_jobs" ADD COLUMN "kind" varchar(20) DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "auto_export_format" varchar(20) DEFAULT 'mp3' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "backup_folder" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "last_backup_at" timestamp;