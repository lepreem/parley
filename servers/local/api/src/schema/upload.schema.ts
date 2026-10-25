import { z } from "zod";
import type { QueueYoutubeBody } from "@parley/contract";
import { takesBody } from "@parley/server-kit/http/takesBody";
import { isYoutubeUrl } from "@parley/contract/youtube";
import { CTX_KEYS, FORM_KEYS } from "../../../core/keys";
import {
  DEFAULT_TRANSCRIBE_MODEL,
  isValidTranscribeModel,
} from "../../../core/ai/ai_transcribe_client";
import { MAX_AUDIO_BYTES } from "../../../core/files";

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
  if (await isValidTranscribeModel(modelId)) return;
  ctx.addIssue({
    code: "custom",
    message: "Invalid transcription model",
    path: [FORM_KEYS.transcriptModelId],
  });
}

/**
 * The `file` field of an upload form: a non-empty file of one kind, no bigger
 * than `maxBytes`. Shared by the image and audio routes so both turn a bad file
 * away the same way.
 */
export function uploadedFileField({
  typePrefix,
  maxBytes,
  wrongType,
  tooLarge,
}: {
  typePrefix: string;
  maxBytes: number;
  wrongType: (type: string) => string;
  tooLarge: string;
}) {
  return z
    .instanceof(File, { message: "A file is required" })
    .refine(
      (file) => file.type.startsWith(typePrefix),
      (file) => ({ message: wrongType(file.type) }),
    )
    .refine((file) => file.size > 0, { message: "The file is empty" })
    .refine((file) => file.size <= maxBytes, { message: tooLarge });
}

/** The name an uploaded file is shown under: its own, within reason. */
export function displayName(file: File, fallback: string) {
  return file.name.trim().slice(0, 255) || fallback;
}

/** POST /upload/audio — an audio file to store and transcribe. */
export const audioUploadSchema = z
  .object({
    [FORM_KEYS.file]: uploadedFileField({
      typePrefix: "audio/",
      maxBytes: MAX_AUDIO_BYTES,
      wrongType: (type) => `Expected an audio file, got: ${type || "unknown"}`,
      tooLarge: "Audio file is too large",
    }),
    [FORM_KEYS.audioSource]: z.preprocess(
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
    [FORM_KEYS.transcriptModelId]: transcriptionModelField,
  })
  .superRefine(async (data, ctx) => {
    await refineTranscriptionModel(data[FORM_KEYS.transcriptModelId], ctx);
  })
  .transform((data) => ({
    [CTX_KEYS.file]: data[FORM_KEYS.file],
    [CTX_KEYS.fileName]: displayName(data[FORM_KEYS.file], "audio"),
    [CTX_KEYS.transcriptModelId]: data[FORM_KEYS.transcriptModelId],
    [CTX_KEYS.audioSource]: data[FORM_KEYS.audioSource],
  }));

/**
 * POST /upload/youtube — a YouTube URL. The audio is fetched off the queue,
 * after the request, so the job is created with placeholder file metadata
 * (real title/size are unknown until the fetch completes).
 */
export const youtubeUploadSchema = takesBody<QueueYoutubeBody>()(
  z
    .object({
      [CTX_KEYS.youtubeUrl]: z.string().url(),
      [FORM_KEYS.transcriptModelId]: transcriptionModelField,
      [CTX_KEYS.useCaptionsIfAvailable]: z.boolean().optional().default(false),
    })
    .superRefine(async (data, ctx) => {
      if (!isYoutubeUrl(data[CTX_KEYS.youtubeUrl])) {
        ctx.addIssue({
          code: "custom",
          message: "Not a valid YouTube URL",
          path: [CTX_KEYS.youtubeUrl],
        });
      }
      await refineTranscriptionModel(data[FORM_KEYS.transcriptModelId], ctx);
    })
    .transform((data) => ({
      [CTX_KEYS.youtubeUrl]: data[CTX_KEYS.youtubeUrl],
      [CTX_KEYS.transcriptModelId]: data[FORM_KEYS.transcriptModelId],
      [CTX_KEYS.useCaptionsIfAvailable]: data[CTX_KEYS.useCaptionsIfAvailable],
    })),
);
