import { z } from "zod";
import { transcriptSegmentSchema } from "@parley/server-kit/transcription/transcript";
import type { UploadId } from "@parley/server-kit/ids";

/**
 * Each queue is named for what its consumer does with a message, with `YT_`
 * on the ones only YouTube uploads go through. The YouTube fetcher takes the
 * two fetch queues, the API the rest.
 */
export const QUEUES = {
  YT_FETCH_CAPTIONS: "yt_fetch_captions",
  YT_FETCH_AUDIO: "yt_fetch_audio",
  YT_SAVE_CAPTIONS: "yt_save_captions",
  TRANSCRIBE_AUDIO: "transcribe_audio",
  YT_FAIL_JOB: "yt_fail_job",
} as const;

export type Queue = (typeof QUEUES)[keyof typeof QUEUES];

const uploadId = z
  .string()
  .uuid()
  .transform((id) => id as UploadId);

const youtubeFetch = z.object({
  audioUploadId: uploadId,
  userId: z.string(),
  url: z.string(),
});

/**
 * What each queue's messages carry. The Python fetcher publishes four of
 * these from its own code, so a consumer checks every message against its
 * schema rather than trusting the shape: one that doesn't fit is
 * dead-lettered before its handler runs.
 */
export const QUEUE_PAYLOAD_SCHEMAS = {
  [QUEUES.YT_FETCH_CAPTIONS]: youtubeFetch,

  /** Also published by the fetcher, for a video with no usable captions. */
  [QUEUES.YT_FETCH_AUDIO]: youtubeFetch,

  [QUEUES.YT_SAVE_CAPTIONS]: z.object({
    audioUploadId: uploadId,
    /** The video's captions, used as the transcript instead of its audio. */
    segments: z.array(transcriptSegmentSchema),
  }),

  [QUEUES.TRANSCRIBE_AUDIO]: z.object({
    audioUploadId: uploadId,
  }),

  [QUEUES.YT_FAIL_JOB]: z.object({
    audioUploadId: uploadId,
    userId: z.string(),
    error: z.string().optional(),
  }),
} as const satisfies Record<Queue, z.ZodTypeAny>;

export type QueuePayloads = {
  [Q in Queue]: z.output<(typeof QUEUE_PAYLOAD_SCHEMAS)[Q]>;
};
