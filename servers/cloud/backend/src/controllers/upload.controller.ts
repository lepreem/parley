import { randomUUID } from "node:crypto";
import type { QueuedYoutube, UploadedAudio } from "@parley/shared/contract";
import { data } from "../data";
import { audioTranscription } from "../audioTranscription";
import { uploads } from "../uploads";
import { mq } from "../message-queue/messageQueue";
import { authed } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import {
  audioConfirmSchema,
  youtubeUploadSchema,
} from "../schema/upload.schema";
import { ALREADY_CONFIRMED, uploadRejection } from "../utils/uploadRejection";
import type { UploadId } from "@parley/shared/types";

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
      transcriptModelId,
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
      transcriptModelId,
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

/** POST /upload/youtube — a YouTube URL fetched out of band by youtube-fetcher. */
export const handleYoutubeUpload = authed.createHandlers(
  validate("json", youtubeUploadSchema),
  async (c) => {
    const { userId } = c.var;
    const {
      youtubeUrl: url,
      transcriptModelId,
      useCaptionsIfAvailable,
    } = c.req.valid("json");

    const audioUploadId: UploadId = randomUUID();

    // Created queued with placeholder metadata. When asked to, the fetcher tries
    // the video's captions first and sends them back as the transcript, falling
    // back to the audio when there are none; otherwise it goes straight to the
    // audio, writes it under `audioUploadId` and queues it to be transcribed.
    await data.jobs.createYoutubeAudioJob({
      audioUploadId,
      userId,
      source: "youtube",
      youtubeSourceUrl: url,
      fileName: "YouTube audio",
      mimeType: null,
      sizeBytes: 0,
      transcriptModelId,
    });

    // A failed publish would leave the job queued with no fetcher coming for
    // it; failing it puts that in front of the user instead.
    await audioTranscription.publishOrFail(audioUploadId, () =>
      mq.publish(
        useCaptionsIfAvailable
          ? mq.queues.YT_FETCH_CAPTIONS
          : mq.queues.YT_FETCH_AUDIO,
        { audioUploadId, url, userId },
      ),
    );
    return c.json({
      audioUploadId,
      source: "youtube",
      url,
    } satisfies QueuedYoutube);
  },
);
