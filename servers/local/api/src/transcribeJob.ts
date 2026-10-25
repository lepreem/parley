import {
  DEFAULT_TRANSCRIBE_MODEL,
  transcribeAI,
} from "../../core/ai/ai_transcribe_client";
import { files } from "../../core/files";
import { data } from "../../core/data";
import { logger } from "@parley/server-kit/runtime/logger";
import {
  DeadLetterError,
  mq,
  type DeliveryMetadata,
} from "../../core/message-queue/messageQueue";
import type { TranscriptSegment } from "@parley/server-kit/transcription/transcript";
import type { UploadId } from "@parley/server-kit/ids";

const log = logger.child({ component: "transcribe" });

/** The audio was transcribed, but there was nothing in it to transcribe. */
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

type ClaimedJob = NonNullable<
  Awaited<ReturnType<typeof data.jobs.claimAudioJob>>
>;

/** The job's audio, transcribed. */
async function transcribeAudio(job: ClaimedJob) {
  return transcribeAI(
    job.transcriptModelId ?? DEFAULT_TRANSCRIBE_MODEL,
    files.path({ kind: "audio", uploadId: job.audioUploadId }),
  );
}

/**
 * What becomes of a job this handler claimed and then failed on.
 *
 * Before the last attempt the claim is handed back and the error rethrown, so
 * the next attempt claims a queued job. If handing it back fails too, the
 * database most likely failed both times, so the message is given up rather
 * than tried again in the same outage.
 *
 * On the last attempt the job fails for good. The job row records that, so
 * the message is done.
 */
async function settleFailedJob(
  audioUploadId: UploadId,
  claimToken: string,
  lastAttempt: boolean,
  error: unknown,
) {
  if (lastAttempt) {
    await data.jobs.failAudioJob(
      audioUploadId,
      claimToken,
      failureMessage(error),
    );
    return;
  }

  let unclaimed: boolean;
  try {
    unclaimed = await data.jobs.unclaimAndResetAudioJob(
      audioUploadId,
      claimToken,
    );
  } catch (unclaimError) {
    throw new DeadLetterError(
      "Could not unclaim and reset the job after it failed; it is left " +
        "processing until the next startup queues it again",
      { cause: unclaimError },
    );
  }
  // Completed, deleted or claimed by a later attempt: nothing to try again.
  if (!unclaimed) return;
  throw error;
}

/**
 * Stores a job's transcript: the video's captions when the message carries
 * them (caption_transcript), otherwise its audio transcribed (transcribe).
 */
export async function handleTranscribeJob(
  {
    audioUploadId,
    segments: captions,
  }: {
    audioUploadId: UploadId;
    segments?: TranscriptSegment[];
  },
  { attempt, lastAttempt }: DeliveryMetadata,
) {
  let claimToken: string | null = null;

  try {
    const job = await data.jobs.claimAudioJob(audioUploadId);
    if (!job) return;
    claimToken = job.claimToken;

    const segments = captions ?? (await transcribeAudio(job));
    if (!segments.some((segment) => segment.text.trim())) {
      throw new NoSpeechError();
    }

    log.debug("Transcription produced", {
      audioUploadId,
      segments: segments.length,
    });

    const saved = await data.transcripts.saveCompletedTranscript(
      audioUploadId,
      segments,
      claimToken,
    );
    if (!saved) {
      log.debug("Discarded result from superseded claim", { audioUploadId });
      return;
    }
  } catch (error) {
    log.error("Transcription job failed", error, { audioUploadId, attempt });
    // Nothing claimed: the consumer tries again or gives it up.
    if (!claimToken) throw error;
    await settleFailedJob(audioUploadId, claimToken, lastAttempt, error);
    return;
  }

  // Tells the browser the job is done, so the user's screen updates.
  mq.publish(mq.queues.TRANSCRIBE_DONE, { audioUploadId });
}
