import { randomUUID } from "node:crypto";
import type { QueuedYoutube, UploadedAudio } from "@parley/contract";
import { data } from "../data";
import { audioTranscription } from "../transcription/audioTranscription";
import { uploads } from "../uploads/uploads";
import { mq } from "../message-queue/messageQueue";
import { authed } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import {
  audioConfirmSchema,
  youtubeUploadSchema,
} from "../schema/upload.schema";
import { ALREADY_CONFIRMED, uploadRejection } from "../uploads/uploadRejection";
import type { UploadId } from "@parley/server-kit/ids";
import { youtubeWatchUrl } from "@parley/contract/youtube";
import { eventHub } from "../sse/hub";

/**
 * POST /upload/audio — a URL the browser PUTs speech audio to, straight into
 * storage. The id is minted here rather than chosen by the client, so the key
 * the URL is bound to is one nothing else is using.
 *
 * Only the upload's ledger record is written, not a job: an upload that never
 * completes is the sweep's to remove, rather than a job stuck queued in the
 * user's sources.
 */
export const handleAudioUploadUrl = authed.createHandlers(async (c) => {
  const { userId } = c.var;

  const audioUploadId: UploadId = randomUUID();
  const signedUploadUrl = await uploads.start(userId, {
    kind: "audio",
    uploadId: audioUploadId,
  });

  return c.json({ uploadId: audioUploadId, signedUploadUrl });
});

const AUDIO_WORDING = {
  noun: "audio",
  wrongType: (contentType: string) =>
    `Expected an audio file, got: ${contentType || "unknown"}`,
  tooLarge: "Audio file is too large",
};

/**
 * POST /upload/audio/confirm — the audio is in the bucket: check it, then
 * start its transcription.
 *
 * The upload must be pending in the ledger for this user as audio, so an id
 * minted for an image — or someone else's — is a 404. A rejected upload is
 * answered and left as it is; the sweep removes it.
 */
export const handleAudioConfirm = authed.createHandlers(
  validate("json", audioConfirmSchema),
  async (c) => {
    const { userId } = c.var;
    const {
      uploadId: audioUploadId,
      fileName,
      audioSource: source,
    } = c.req.valid("json");

    const upload = await uploads.check(userId, {
      kind: "audio",
      uploadId: audioUploadId,
    });
    if (!upload.ok) {
      const [body, status] = uploadRejection(upload, AUDIO_WORDING);
      return c.json(body, status);
    }

    const queued = await audioTranscription.queue({
      audioUploadId,
      userId,
      source,
      fileName,
      mimeType: upload.contentType,
      sizeBytes: upload.sizeBytes,
    });
    if (!queued) {
      return c.json({ message: ALREADY_CONFIRMED }, 409);
    }

    return c.json({
      audioUploadId,
      fileName,
      size: upload.sizeBytes,
      mimeType: upload.contentType,
      source,
    } satisfies UploadedAudio);
  },
);

/**
 * Why a YouTube video is turned away with captions off. YouTube blocks this
 * server's downloads, so for now the cloud only takes a video's captions; the
 * client keeps the option on.
 */
export const CAPTIONS_ONLY =
  "Parley can only use a YouTube video's captions for now. Turn on “Use YouTube captions”, or upload the audio or video file instead.";

/**
 * POST /upload/youtube — a YouTube video, whose captions are fetched out of
 * band (src/transcription/youtubeCaptionsJob.ts). A video someone has already
 * transcribed isn't fetched again: the job starts out completed, with a copy
 * of that transcript.
 */
export const handleYoutubeUpload = authed.createHandlers(
  validate("json", youtubeUploadSchema),
  async (c) => {
    const { userId } = c.var;
    const {
      youtubeUrl: url,
      youtubeVideoId,
      useCaptionsIfAvailable,
    } = c.req.valid("json");
    if (!useCaptionsIfAvailable) {
      return c.json({ message: CAPTIONS_ONLY }, 400);
    }

    const audioUploadId: UploadId = randomUUID();
    const job = {
      audioUploadId,
      userId,
      source: "youtube" as const,
      youtubeVideoId,
      fileName: "YouTube audio",
      mimeType: null,
      sizeBytes: 0,
    };
    const queued = {
      audioUploadId,
      source: "youtube",
      url,
    } satisfies QueuedYoutube;

    const transcript = await data.transcripts.findYoutubeTranscript(
      youtubeVideoId,
      { useCaptionsIfAvailable },
    );
    if (transcript) {
      await data.transcripts.createReusedYoutubeJob(job, transcript);
      eventHub.send(userId, "jobUpdated", { audioUploadId });
      return c.json(queued);
    }

    // Created queued with placeholder metadata, for the captions to complete.
    await data.jobs.createAudioJob(job);

    // A failed publish would leave the job queued with nothing coming for it;
    // failing it puts that in front of the user instead.
    await audioTranscription.publishOrFail(audioUploadId, () =>
      mq.publish(mq.queues.YT_FETCH_CAPTIONS, {
        audioUploadId,
        // Only the video: a playlist or start time on the link the user
        // pasted is nothing to act on.
        url: youtubeWatchUrl(youtubeVideoId),
        userId,
      }),
    );
    return c.json(queued);
  },
);
