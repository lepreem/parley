ALTER TABLE `audio_transcription_jobs` ADD `youtube_video_id` text;--> statement-breakpoint
ALTER TABLE `audio_transcription_jobs` DROP COLUMN `YT_source_url`;