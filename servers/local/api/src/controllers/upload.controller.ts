import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import type { QueuedYoutube, UploadedAudio } from "@parley/contract";
import { data } from "../../../core/data";
import { queueAudioTranscription } from "../../../core/audioTranscription";
import { files } from "../../../core/files";
import { mq } from "../../../core/message-queue/messageQueue";
import { CTX_KEYS } from "../../../core/keys";
import type { UploadId } from "@parley/server-kit/ids";

/**
 * POST /upload/audio — speech audio, stored under an id minted here and queued
 * for transcription. The file is written before its rows; a crash in between
 * leaves a file the next startup removes.
 */
export async function handleAudioUpload(c: Context) {
  const file: File = c.get(CTX_KEYS.file);
  const fileName: string = c.get(CTX_KEYS.fileName);
  const source = c.get(CTX_KEYS.audioSource);
  const transcriptModelId = c.get(CTX_KEYS.transcriptModelId);
  const audioUploadId: UploadId = randomUUID();

  await files.write(
    { kind: "audio", uploadId: audioUploadId },
    new Uint8Array(await file.arrayBuffer()),
  );
  await queueAudioTranscription({
    audioUploadId,
    source,
    fileName,
    mimeType: file.type,
    sizeBytes: file.size,
    transcriptModelId,
  });

  return c.json({
    audioUploadId,
    fileName,
    size: file.size,
    mimeType: file.type,
    source,
  } satisfies UploadedAudio);
}

/** POST /upload/youtube — a YouTube URL, fetched off the queue. */
export async function handleYoutubeUpload(c: Context) {
  const url = c.get(CTX_KEYS.youtubeUrl);
  const transcriptModelId = c.get(CTX_KEYS.transcriptModelId);
  const useCaptionsIfAvailable = c.get(CTX_KEYS.useCaptionsIfAvailable);

  const audioUploadId: UploadId = randomUUID();

  // Created queued with placeholder metadata. When asked to, the fetch tries
  // the video's captions first and sends them on as the transcript;
  // otherwise it writes audio under `audioUploadId` to be transcribed.
  await data.jobs.createAudioJob({
    audioUploadId,
    source: "youtube",
    youtubeSourceUrl: url,
    useCaptionsIfAvailable,
    fileName: "YouTube audio",
    mimeType: null,
    sizeBytes: 0,
    transcriptModelId,
  });

  mq.publish(mq.queues.YT_FETCH, {
    audioUploadId,
    url,
    useCaptionsIfAvailable,
  });
  return c.json({
    audioUploadId,
    source: "youtube",
    url,
  } satisfies QueuedYoutube);
}
