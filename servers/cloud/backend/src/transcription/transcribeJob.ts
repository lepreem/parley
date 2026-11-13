import { transcription } from "../ai";
import { sign } from "../storage";
import type * as mq from "../message-queue/messageQueue";
import type { UploadId } from "@parley/server-kit/ids";
import { completeAudioJob, type ClaimedJob } from "./audioJob";

/**
 * How many transcriptions Deepgram runs at once for the whole project, across
 * every API instance. Deepgram allows 50 on Pay As You Go, a limit that plan
 * can't raise, and refuses more with a 429; this leaves 10 for anything else
 * using the same Deepgram project, such as development.
 */
const DEEPGRAM_CONCURRENCY = 40;

/**
 * How many audio jobs this API instance transcribes at once: its share of
 * DEEPGRAM_CONCURRENCY, so every instance together stays under Deepgram's
 * limit. The rest wait in the queue.
 *
 * There's one instance, so its share is all of it. Once the API scales out,
 * this asks the load balancer, which knows how many instances there are and
 * divides DEEPGRAM_CONCURRENCY between them. Read once, when the consumer
 * starts.
 */
export async function getTranscriptionConcurrency(): Promise<number> {
  return DEEPGRAM_CONCURRENCY;
}

/** The job's audio, transcribed. */
async function transcribeAudio(
  job: ClaimedJob,
  cancelled: AbortSignal,
): Promise<transcription.Transcription> {
  cancelled.throwIfAborted();
  const model = await transcription.model();
  if (!model) {
    throw new Error("Deepgram offers no transcription model");
  }
  cancelled.throwIfAborted();
  const audioUrl = await sign.url(job.userId, {
    kind: "audio",
    uploadId: job.audioUploadId,
  });
  cancelled.throwIfAborted();
  return transcription.transcribe(model, audioUrl, cancelled);
}

/** A file's job: its transcript is the audio, transcribed by Deepgram. */
export async function handleTranscribeJob(
  { audioUploadId }: { audioUploadId: UploadId },
  delivery: mq.DeliveryMetadata,
) {
  await completeAudioJob(audioUploadId, delivery, async (job, cancelled) => ({
    ...(await transcribeAudio(job, cancelled)),
    fromCaptions: false,
  }));
}
