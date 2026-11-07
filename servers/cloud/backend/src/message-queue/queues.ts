import { z } from "zod";
import type { UploadId } from "@parley/server-kit/ids";

/**
 * Each queue is named for what its consumer does with a message, with `YT_`
 * on the ones only YouTube uploads go through. The API both publishes and
 * consumes them.
 */
export const QUEUES = {
  YT_FETCH_CAPTIONS: "yt_fetch_captions",
  TRANSCRIBE_AUDIO: "transcribe_audio",
} as const;

export type Queue = (typeof QUEUES)[keyof typeof QUEUES];

const uploadId = z
  .string()
  .uuid()
  .transform((id) => id as UploadId);

/**
 * What each queue's messages carry. A consumer checks every message against
 * its schema rather than trusting the shape: one that doesn't fit is
 * dead-lettered before its handler runs.
 */
export const QUEUE_PAYLOAD_SCHEMAS = {
  /** A YouTube job, whose transcript is the video's captions. */
  [QUEUES.YT_FETCH_CAPTIONS]: z.object({
    audioUploadId: uploadId,
    userId: z.string(),
    /** The video alone, without the playlist or start time of the link pasted. */
    url: z.string(),
  }),

  [QUEUES.TRANSCRIBE_AUDIO]: z.object({
    audioUploadId: uploadId,
  }),
} as const satisfies Record<Queue, z.ZodTypeAny>;

export type QueuePayloads = {
  [Q in Queue]: z.output<(typeof QUEUE_PAYLOAD_SCHEMAS)[Q]>;
};
