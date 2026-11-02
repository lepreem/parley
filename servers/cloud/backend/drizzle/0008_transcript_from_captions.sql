ALTER TABLE "transcript_contents" ADD COLUMN "from_captions" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "audio_transcription_jobs" DROP COLUMN "transcription_model_id";