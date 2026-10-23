import { z } from "zod";
import { transcriptSegmentSchema } from "@parley/shared/transcript";
import type { UploadId } from "@parley/shared/types";

/**
 * Each queue is named for what its consumer does with a message. The YouTube
 * fetcher takes the two fetch queues, the API the rest.
 */
export const QUEUES = {
  FETCH_YOUTUBE_CAPTIONS: "fetch_youtube_captions",
  FETCH_YOUTUBE_AUDIO: "fetch_youtube_audio",
  SAVE_CAPTIONS: "save_captions",
  TRANSCRIBE_AUDIO: "transcribe_audio",
  FAIL_YOUTUBE_JOB: "fail_youtube_job",
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
  [QUEUES.FETCH_YOUTUBE_CAPTIONS]: youtubeFetch,

  /** Also published by the fetcher, for a video with no usable captions. */
  [QUEUES.FETCH_YOUTUBE_AUDIO]: youtubeFetch,

  [QUEUES.SAVE_CAPTIONS]: z.object({
    audioUploadId: uploadId,
    /** The video's captions, used as the transcript instead of its audio. */
    segments: z.array(transcriptSegmentSchema),
  }),

  [QUEUES.TRANSCRIBE_AUDIO]: z.object({
    audioUploadId: uploadId,
  }),

  [QUEUES.FAIL_YOUTUBE_JOB]: z.object({
    audioUploadId: uploadId,
    userId: z.string(),
    error: z.string().optional(),
  }),
} as const satisfies Record<Queue, z.ZodTypeAny>;

export type QueuePayloads = {
  [Q in Queue]: z.output<(typeof QUEUE_PAYLOAD_SCHEMAS)[Q]>;
};
