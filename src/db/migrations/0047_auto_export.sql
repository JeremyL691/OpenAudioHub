ALTER TABLE "recordings" ADD COLUMN "auto_export_path" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "auto_export_folder" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "auto_export_title_mode" varchar(20) DEFAULT 'original' NOT NULL;