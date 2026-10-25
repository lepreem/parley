import { z } from "zod";
import type { QueueYoutubeBody } from "@parley/contract";
import { takesBody } from "@parley/server-kit/http/takesBody";
import { isYoutubeUrl } from "@parley/contract/youtube";
import type { UploadId } from "@parley/server-kit/ids";
import { DEFAULT_TRANSCRIBE_MODEL, transcription } from "../ai";

/** Treat a blank ("" or null) optional field as unset. */
const blankToUndefined = (v: unknown) =>
  v === "" || v === null ? undefined : v;

/**
 * The transcription model is optional on every route that has one — omit it
 * (or send blank) to get the default.
 */
const transcriptionModelField = z.preprocess(
  blankToUndefined,
  z.string().min(1).optional().default(DEFAULT_TRANSCRIBE_MODEL),
);

/**
 * Shared by the audio and youtube routes so the two reject an unusable model
 * with one message on one path rather than two copies that can drift apart.
 */
async function refineTranscriptionModel(modelId: string, ctx: z.RefinementCtx) {
  if (await transcription.isValidModel(modelId)) return;
  ctx.addIssue({
    code: "custom",
    message: "Invalid transcription model",
    path: ["transcriptModelId"],
  });
}

/** The id a mint handed out and the name of the file the client uploaded to it. */
export const uploadIdField = z
  .string()
  .uuid({ message: "Invalid upload id" })
  // A UUID is exactly what UploadId spells out; zod can't type it that narrowly.
  .transform((id) => id as UploadId);
export const fileNameField = z.string().trim().min(1).max(255);

/**
 * POST /upload/audio/confirm — the audio is in the bucket; record the job and
 * transcribe it. Size and type are not in the body: the controller reads both
 * back from storage, since the client no longer sends the bytes through here.
 */
export const audioConfirmSchema = z
  .object({
    uploadId: uploadIdField,
    fileName: fileNameField,
    audioSource: z.preprocess(
      blankToUndefined,
      z
        .enum(["video", "audio"], {
          errorMap: () => ({
            message: 'Invalid source; use "video" or "audio" (or omit)',
          }),
        })
        .optional()
        .default("audio"),
    ),
    transcriptModelId: transcriptionModelField,
  })
  .superRefine(async (data, ctx) => {
    await refineTranscriptionModel(data.transcriptModelId, ctx);
  });

/**
 * POST /upload/youtube — a YouTube URL. The youtube-fetcher service downloads
 * the audio out of band, so the job is created with placeholder file metadata
 * (real title/size are unknown until the fetch completes).
 */
export const youtubeUploadSchema = takesBody<QueueYoutubeBody>()(
  z
    .object({
      youtubeUrl: z.string().url(),
      transcriptModelId: transcriptionModelField,
      useCaptionsIfAvailable: z.boolean().optional().default(false),
    })
    .superRefine(async (data, ctx) => {
      if (!isYoutubeUrl(data.youtubeUrl)) {
        ctx.addIssue({
          code: "custom",
          message: "Not a valid YouTube URL",
          path: ["youtubeUrl"],
        });
      }
      await refineTranscriptionModel(data.transcriptModelId, ctx);
    }),
);
