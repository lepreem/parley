ALTER TABLE "audio_transcription_jobs" ADD COLUMN "youtube_video_id" text;--> statement-breakpoint
CREATE INDEX "audio_transcription_jobs_youtube_video_completed_idx" ON "audio_transcription_jobs" USING btree ("youtube_video_id") WHERE "audio_transcription_jobs"."status" = 'completed';--> statement-breakpoint
ALTER TABLE "audio_transcription_jobs" DROP COLUMN "YT_source_url";