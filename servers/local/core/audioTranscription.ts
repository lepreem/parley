import { data } from "./data";
import { logger } from "@parley/server-kit/runtime/logger";
import { mq } from "./message-queue/messageQueue";
import type { UploadId } from "@parley/server-kit/ids";

const log = logger.child({ component: "audio-transcription" });

/**
 * Records an uploaded audio file, already written, as a transcription job and
 * queues it for transcription.
 */
export async function queueAudioTranscription(job: {
  audioUploadId: UploadId;
  source: "audio" | "video";
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  transcriptModelId: string;
}) {
  await data.jobs.createAudioJob(job);
  mq.publish(mq.queues.TRANSCRIBE, { audioUploadId: job.audioUploadId });
}

/**
 * Puts every unfinished job back on its queue. The queues are in memory, so
 * whatever was on them when the process last stopped is gone; the job rows
 * say what was left to do. A YouTube job is fetched again, since there's no
 * telling whether its fetch finished; any other is transcribed.
 *
 * Runs at startup, before the consumers start.
 */
export async function resumeUnfinishedJobs() {
  const jobs = await data.jobs.requeueUnfinishedAudioJobs();
  for (const job of jobs) {
    if (job.source === "youtube" && job.youtubeSourceUrl) {
      mq.publish(mq.queues.YT_FETCH, {
        audioUploadId: job.audioUploadId,
        url: job.youtubeSourceUrl,
        useCaptionsIfAvailable: job.useCaptionsIfAvailable ?? false,
      });
    } else {
      mq.publish(mq.queues.TRANSCRIBE, { audioUploadId: job.audioUploadId });
    }
  }
  if (jobs.length > 0)
    log.info("Resumed unfinished jobs", { count: jobs.length });
}
