import * as data from "../data";
import { logger } from "@parley/server-kit/runtime/logger";
import * as mq from "../message-queue";
import type { TranscriptSegment } from "@parley/server-kit/transcription/transcript";
import type { UploadId } from "@parley/server-kit/ids";
import { eventHub } from "../sse/hub";
import * as jobCancellation from "@parley/server-kit/transcription/jobCancellation";

const log = logger.child({ component: "audioJob" });

/** An audio job this worker holds the claim on. */
export type ClaimedJob = NonNullable<
  Awaited<ReturnType<typeof data.jobs.claimAudioJob>>
>;

/** A job's transcript, and where it came from. */
type Transcript = {
  segments: TranscriptSegment[];
  /** The language spoken ("de", "ar"); null if the source named none. */
  language: string | null;
  fromCaptions: boolean;
};

/** The transcript was made, but there was nothing in it. */
class NoSpeechError extends Error {
  constructor() {
    super("No speech found in the audio");
    this.name = "NoSpeechError";
  }
}

/**
 * What a job that failed for good tells the user. Their screen shows it next
 * to the file's name, so anything but an empty transcript gets a general
 * message; the actual error is in the logs.
 */
function failureMessage(error: unknown) {
  return error instanceof NoSpeechError
    ? error.message
    : "Could not be transcribed";
}

/**
 * What becomes of a job this worker claimed and then failed on.
 *
 * Before the last attempt the claim is handed back and the error rethrown, so
 * the next attempt claims a queued job. If handing it back fails too, the
 * database most likely failed both times, so the message is dead-lettered
 * rather than tried again in the same outage.
 *
 * On the last attempt the job fails for good. The job row records that, so
 * the message is done. Returns whether this worker failed it, so the user is
 * told only about a failure that was recorded.
 */
async function settleFailedJob(
  audioUploadId: UploadId,
  claimToken: string,
  lastAttempt: boolean,
  error: unknown,
) {
  if (lastAttempt) {
    return data.jobs.failAudioJob(
      audioUploadId,
      claimToken,
      failureMessage(error),
    );
  }

  let unclaimed: boolean;
  try {
    unclaimed = await data.jobs.unclaimAndResetAudioJob(
      audioUploadId,
      claimToken,
    );
  } catch (unclaimError) {
    throw new mq.DeadLetterError(
      "Could not unclaim and reset the job after it failed; it is left processing, " +
        "so reset it to queued with no claim token before replaying this",
      { cause: unclaimError },
    );
  }
  // Completed, deleted or claimed by another worker: nothing to try again.
  if (!unclaimed) return false;
  throw error;
}

/**
 * Claims a queued audio job, gets its transcript from `transcriptOf`, and
 * saves it; or, when that fails, retries or fails the job for good (see
 * settleFailedJob). Every audio job ends here, whatever its transcript is
 * made from: a file transcribed (transcribeJob.ts) or a video's captions
 * (youtubeCaptionsJob.ts).
 *
 * `cancelled` fires when the user deletes the job while it's worked on. A
 * slow source, like Deepgram, should stop on it; either way, a deleted job is
 * neither retried nor reported as failed.
 */
export async function completeAudioJob(
  audioUploadId: UploadId,
  { attempt, lastAttempt, redelivered }: mq.DeliveryMetadata,
  transcriptOf: (
    job: ClaimedJob,
    cancelled: AbortSignal,
  ) => Promise<Transcript>,
) {
  let job: ClaimedJob | null = null;
  const { signal: cancelled, finish } = jobCancellation.start(audioUploadId);

  try {
    job = await data.jobs.claimAudioJob(audioUploadId, redelivered);
    if (!job) return;
    const { claimToken } = job;

    const transcript = await transcriptOf(job, cancelled);
    cancelled.throwIfAborted();
    if (!transcript.segments.some((segment) => segment.text.trim())) {
      throw new NoSpeechError();
    }

    log.debug("Transcript produced", {
      audioUploadId,
      segments: transcript.segments.length,
      fromCaptions: transcript.fromCaptions,
    });

    const saved = await data.transcripts.saveCompletedTranscript(
      audioUploadId,
      transcript,
      claimToken,
    );
    if (!saved) {
      log.debug("Discarded result from superseded claim", { audioUploadId });
      return;
    }
  } catch (error) {
    // The user deleted the job, so there's nothing to retry or report.
    if (cancelled.aborted) {
      log.debug("Audio job cancelled", { audioUploadId });
      return;
    }
    log.error("Audio job failed", error, {
      audioUploadId,
      attempt,
      redelivered,
    });
    // Nothing claimed: the consumer tries again or dead-letters it.
    if (!job) throw error;
    const failed = await settleFailedJob(
      audioUploadId,
      job.claimToken,
      lastAttempt,
      error,
    );
    // The client stops polling while its stream is open, so a failure it
    // isn't told about shows as processing until the page reloads.
    if (failed) eventHub.send(job.userId, "jobUpdated", { audioUploadId });
    return;
  } finally {
    finish();
  }

  // Tells the user's open streams the job is done, so their screen updates.
  eventHub.send(job.userId, "jobUpdated", { audioUploadId });
}
