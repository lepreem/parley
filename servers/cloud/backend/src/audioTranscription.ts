import { data } from "./data";
import { mq } from "./message-queue/messageQueue";
import type { UploadId } from "@parley/shared/types";
import { uploads } from "./uploads";

/**
 * Confirms an uploaded audio file as a transcription job and hands it to the
 * worker. The job's rows are written in the transaction that confirms the
 * upload, so returns false, queueing nothing, when another confirm got there
 * first.
 *
 * The publish is not part of that transaction, so a failed publish would
 * leave a queued job no worker will ever take. Failing the job says so
 * instead, and the error reaches the user on the source.
 */
async function queue(job: {
  audioUploadId: UploadId;
  userId: string;
  source: "audio" | "video";
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  transcriptModelId: string;
}) {
  const confirmed = await uploads.confirm(
    job.userId,
    { kind: "audio", uploadId: job.audioUploadId },
    (executor) => data.jobs.createAudioJob(job, executor),
  );
  if (!confirmed) return false;

  await publishOrFail(job.audioUploadId, () =>
    mq.publish(mq.queues.TRANSCRIBE_AUDIO, {
      audioUploadId: job.audioUploadId,
    }),
  );
  return true;
}

/**
 * Publishes the work a job is waiting on, and fails the job if that publish
 * doesn't go through. It can't cover a process that dies between the two:
 * a job left queued past its worker's reach is a separate problem.
 */
async function publishOrFail(
  audioUploadId: UploadId,
  publish: () => Promise<unknown>,
) {
  try {
    await publish();
  } catch (error) {
    await data.jobs.failAudioJobById(
      audioUploadId,
      "Could not be queued for processing",
    );
    throw error;
  }
}

export const audioTranscription = {
  queue,
  publishOrFail,
};
