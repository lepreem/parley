import { z } from "zod";
import type { QueueYoutubeBody } from "@parley/contract";
import { takesBody } from "@parley/server-kit/http/takesBody";
import { youtubeVideoId } from "@parley/contract/youtube";
import { CTX_KEYS, FORM_KEYS } from "../../../core/keys";
import { MAX_AUDIO_BYTES } from "../../../core/files";

/** Treat a blank ("" or null) optional field as unset. */
const blankToUndefined = (v: unknown) =>
  v === "" || v === null ? undefined : v;

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
  })
  .transform((data) => ({
    [CTX_KEYS.file]: data[FORM_KEYS.file],
    [CTX_KEYS.fileName]: displayName(data[FORM_KEYS.file], "audio"),
    [CTX_KEYS.audioSource]: data[FORM_KEYS.audioSource],
  }));

/**
 * POST /upload/youtube — a link to one YouTube video, known from here on by
 * its id. The audio is fetched off the queue, after the request, so the job
 * is created with placeholder file metadata (real title/size are unknown
 * until the fetch completes).
 */
export const youtubeUploadSchema = takesBody<QueueYoutubeBody>()(
  z
    .object({
      [CTX_KEYS.youtubeUrl]: z.string().url(),
      [CTX_KEYS.useCaptionsIfAvailable]: z.boolean().optional().default(false),
    })
    .superRefine((data, ctx) => {
      if (!youtubeVideoId(data[CTX_KEYS.youtubeUrl])) {
        ctx.addIssue({
          code: "custom",
          message: "Not a valid YouTube URL",
          path: [CTX_KEYS.youtubeUrl],
        });
      }
    })
    // The refinement above has turned away every URL without a video id.
    .transform((data) => ({
      [CTX_KEYS.youtubeUrl]: data[CTX_KEYS.youtubeUrl],
      [CTX_KEYS.youtubeVideoId]: youtubeVideoId(data[CTX_KEYS.youtubeUrl])!,
      [CTX_KEYS.useCaptionsIfAvailable]: data[CTX_KEYS.useCaptionsIfAvailable],
    })),
);
