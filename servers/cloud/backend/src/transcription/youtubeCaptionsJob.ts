import { data } from "../data";
import { logger } from "@parley/server-kit/runtime/logger";
import type { DeliveryMetadata } from "../message-queue/messageQueue";
import type { UploadId } from "@parley/server-kit/ids";
import { eventHub } from "../sse/hub";
import { CAPTIONS_MESSAGES, CaptionsError, youtubeCaptions } from "../supadata";
import { handleTranscribeJob } from "./transcribeJob";

const log = logger.child({ component: "youtube-captions" });

/**
 * A YouTube job's transcript, from the video's captions. The cloud only takes
 * captions for now: YouTube blocks this server's downloads, so a video without
 * them fails, telling the person to upload the file instead.
 */
export async function handleYoutubeCaptionsJob(
  {
    audioUploadId,
    userId,
    url,
  }: { audioUploadId: UploadId; userId: string; url: string },
  delivery: DeliveryMetadata,
) {
  // Each fetch spends a Supadata credit, so not for a job deleted while it
  // waited.
  const job = await data.jobs.findAudioJob(userId, audioUploadId);
  if (job?.status !== "queued") return;

  let captions;
  try {
    captions = await youtubeCaptions.fetchCaptions(url);
  } catch (error) {
    if (!(error instanceof CaptionsError)) {
      log.error("Fetching captions failed", error, { audioUploadId });
    }
    await fail(
      audioUploadId,
      userId,
      error instanceof CaptionsError
        ? error.message
        : CAPTIONS_MESSAGES.unavailable,
    );
    return;
  }
  if (!captions) {
    await fail(audioUploadId, userId, CAPTIONS_MESSAGES.noCaptions);
    return;
  }

  await handleTranscribeJob({ audioUploadId, ...captions }, delivery);
}

async function fail(audioUploadId: UploadId, userId: string, error: string) {
  await data.jobs.failAudioJobById(audioUploadId, error);
  eventHub.send(userId, "jobUpdated", { audioUploadId });
}
