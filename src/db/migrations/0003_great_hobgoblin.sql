ALTER TABLE "user_settings" ALTER COLUMN "sync_interval" SET DEFAULT 300000;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "auto_sync_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "sync_on_mount" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "sync_on_visibility_change" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "sync_notifications" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "default_playback_speed" real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "default_volume" integer DEFAULT 75 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "auto_play_next" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "default_transcription_language" varchar(10);--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "transcription_quality" varchar(20) DEFAULT 'balanced' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "date_time_format" varchar(20) DEFAULT 'relative' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "recording_list_sort_order" varchar(20) DEFAULT 'newest' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "items_per_page" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "theme" varchar(20) DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "auto_delete_recordings" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "retention_days" integer;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "browser_notifications" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "email_notifications" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "notification_sound" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "notification_email" varchar(255);--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "default_export_format" varchar(10) DEFAULT 'json' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "auto_export" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "backup_frequency" varchar(20);