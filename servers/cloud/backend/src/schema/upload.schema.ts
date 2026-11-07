import { z } from "zod";
import type { QueueYoutubeBody } from "@parley/contract";
import { takesBody } from "@parley/server-kit/http/takesBody";
import { youtubeVideoId } from "@parley/contract/youtube";
import type { UploadId } from "@parley/server-kit/ids";

/** Treat a blank ("" or null) optional field as unset. */
const blankToUndefined = (v: unknown) =>
  v === "" || v === null ? undefined : v;

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
 * Nor is the transcription model: the server picks it when it transcribes.
 */
export const audioConfirmSchema = z.object({
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
});

/**
 * POST /upload/youtube — a link to one YouTube video, known from here on by
 * its id. Its captions are fetched out of band, so the job is created with
 * placeholder file metadata.
 */
export const youtubeUploadSchema = takesBody<QueueYoutubeBody>()(
  z
    .object({
      youtubeUrl: z.string().url(),
      useCaptionsIfAvailable: z.boolean().optional().default(false),
    })
    .superRefine((data, ctx) => {
      if (!youtubeVideoId(data.youtubeUrl)) {
        ctx.addIssue({
          code: "custom",
          message: "Not a valid YouTube URL",
          path: ["youtubeUrl"],
        });
      }
    })
    // The refinement above has turned away every URL without one.
    .transform((data) => ({
      ...data,
      youtubeVideoId: youtubeVideoId(data.youtubeUrl)!,
    })),
);
