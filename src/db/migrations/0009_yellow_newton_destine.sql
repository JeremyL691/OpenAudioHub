CREATE INDEX "plaud_devices_user_id_idx" ON "plaud_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recordings_user_id_idx" ON "recordings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recordings_plaud_file_id_idx" ON "recordings" USING btree ("plaud_file_id");--> statement-breakpoint
CREATE INDEX "recordings_user_id_start_time_idx" ON "recordings" USING btree ("user_id","start_time");--> statement-breakpoint
CREATE INDEX "transcriptions_recording_id_idx" ON "transcriptions" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "transcriptions_user_id_idx" ON "transcriptions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "plaud_devices" ADD CONSTRAINT "plaud_devices_user_id_serial_number_unique" UNIQUE("user_id","serial_number");