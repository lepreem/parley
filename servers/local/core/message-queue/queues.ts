import type { TranscriptSegment } from "@parley/server-kit/transcription/transcript";
import type { UploadId } from "@parley/server-kit/ids";

export const QUEUES = {
  TRANSCRIBE: "transcribe",
  TRANSCRIBE_DONE: "transcribe_done",
  YT_FETCH: "yt_fetch",
  YT_FETCH_FAILED: "yt_fetch_failed",
  CAPTION_TRANSCRIPT: "caption_transcript",
} as const;

export type Queue = (typeof QUEUES)[keyof typeof QUEUES];
export type QueuePayloads = {
  [QUEUES.TRANSCRIBE]: {
    audioUploadId: UploadId;
  };

  [QUEUES.TRANSCRIBE_DONE]: {
    audioUploadId: UploadId;
  };

  [QUEUES.YT_FETCH]: {
    audioUploadId: UploadId;
    url: string;
    useCaptionsIfAvailable: boolean;
  };

  [QUEUES.YT_FETCH_FAILED]: {
    audioUploadId: UploadId;
    error?: string;
  };

  [QUEUES.CAPTION_TRANSCRIPT]: {
    audioUploadId: UploadId;
    /** The video's captions, used as the transcript instead of its audio. */
    segments: TranscriptSegment[];
  };
};
