import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPublish, mockIsValidTranscribeModel } = vi.hoisted(() => ({
  mockPublish: vi.fn(),
  mockIsValidTranscribeModel: vi.fn(),
}));

vi.mock("../../core/db", async () =>
  (await import("../helpers/inMemoryDb")).inMemoryDbModule(),
);

// Small limits, so the oversized bodies below are kilobytes, not megabytes.
vi.mock("../../core/files", async (importActual) => ({
  ...(await importActual<typeof import("../../core/files")>()),
  MAX_AUDIO_BYTES: 1024,
}));

vi.mock("../../core/ai/ai_transcribe_client", async (importActual) => {
  const actual =
    await importActual<typeof import("../../core/ai/ai_transcribe_client")>();
  return {
    ...actual, // preserves DEFAULT_TRANSCRIBE_MODEL
    isValidTranscribeModel: mockIsValidTranscribeModel,
  };
});

vi.mock("../../core/message-queue/messageQueue", async (importActual) => {
  const { QUEUES } =
    await importActual<
      typeof import("../../core/message-queue/messageQueue")
    >();
  return { mq: { queues: QUEUES, publish: mockPublish } };
});

import { Attachments, AudioTranscriptionJobs, db } from "../../core/db";
import { files, MAX_AUDIO_BYTES } from "../../core/files";
import { createApp } from "../../api/app";
import { originHeaders } from "../helpers/headers";
import { deleteAllRows } from "../helpers/inMemoryDb";

const SOUND = new TextEncoder().encode("sound");
const YT_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

async function uploadAudio(file?: File, fields: Record<string, string> = {}) {
  const form = new FormData();
  if (file) form.append("file", file);
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return (await createApp()).request("http://localhost/upload/audio", {
    method: "POST",
    headers: originHeaders(),
    body: form,
  });
}

async function postYoutube(body: unknown) {
  return (await createApp()).request("http://localhost/upload/youtube", {
    method: "POST",
    headers: { ...originHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const talk = () => new File([SOUND], "talk.mp3", { type: "audio/mpeg" });

beforeEach(async () => {
  vi.clearAllMocks();
  mockIsValidTranscribeModel.mockResolvedValue(true);
  await deleteAllRows(db);
});

describe("POST /upload/text", () => {
  it("is gone — summarization is a chat prompt now", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/upload/text", {
      method: "POST",
      headers: originHeaders(),
      body: new FormData(),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /upload/audio", () => {
  it("stores the audio and its job, then queues transcription", async () => {
    const res = await uploadAudio(talk(), { audioSource: "video" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { audioUploadId: string };
    expect(body).toEqual({
      audioUploadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      fileName: "talk.mp3",
      size: SOUND.length,
      mimeType: "audio/mpeg",
      source: "video",
    });
    expect(
      await files.read({ kind: "audio", uploadId: body.audioUploadId }),
    ).toEqual(Buffer.from(SOUND));
    expect(await db.select().from(Attachments)).toEqual([
      expect.objectContaining({
        attachmentId: body.audioUploadId,
        kind: "audio",
        fileName: "talk.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: SOUND.length,
      }),
    ]);
    expect(await db.select().from(AudioTranscriptionJobs)).toEqual([
      expect.objectContaining({
        audioUploadId: body.audioUploadId,
        source: "video",
        status: "queued",
        transcriptModelId: "small",
      }),
    ]);
    expect(mockPublish).toHaveBeenCalledWith("transcribe", {
      audioUploadId: body.audioUploadId,
    });
  });

  it("defaults the source to audio", async () => {
    const res = await uploadAudio(talk());

    expect(((await res.json()) as { source: string }).source).toBe("audio");
  });

  it.each([
    ["no file", undefined, {}, "A file is required"],
    [
      "something that isn't audio",
      new File([SOUND], "notes.txt", { type: "text/plain" }),
      {},
      "Expected an audio file, got: text/plain",
    ],
    [
      // Multipart gives a file sent without a type the generic one.
      "a file sent without a type",
      new File([SOUND], "mystery"),
      {},
      "Expected an audio file, got: application/octet-stream",
    ],
    [
      "an empty file",
      new File([], "silence.mp3", { type: "audio/mpeg" }),
      {},
      "The file is empty",
    ],
    [
      "an invalid source",
      talk(),
      { audioSource: "podcast" },
      'Invalid source; use "video" or "audio" (or omit)',
    ],
  ])(
    "refuses %s, storing and queueing nothing",
    async (_case, file, fields, message) => {
      const res = await uploadAudio(file, fields);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ message });
      expect(await db.select().from(Attachments)).toEqual([]);
      expect(mockPublish).not.toHaveBeenCalled();
    },
  );

  it("refuses an unusable transcription model", async () => {
    mockIsValidTranscribeModel.mockResolvedValue(false);

    const res = await uploadAudio(talk(), { transcriptModelId: "nope" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      message: "Invalid transcription model",
    });
  });

  it("refuses a body far over the limit without reading it", async () => {
    const res = await uploadAudio(
      // Past the limit and the room left for the rest of the form.
      new File([new Uint8Array(MAX_AUDIO_BYTES + 128 * 1024)], "long.mp3", {
        type: "audio/mpeg",
      }),
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ message: "Audio file is too large" });
  });
});

describe("POST /upload/youtube", () => {
  it("returns 400 for a non-YouTube URL", async () => {
    const res = await postYoutube({
      youtubeUrl: "https://example.com/watch?v=x",
    });

    expect(res.status).toBe(400);
    // The schema's own message must reach the client, not a generic string.
    expect(await res.json()).toEqual({ message: "Not a valid YouTube URL" });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("creates a job and queues its fetch, storing nothing yet", async () => {
    const res = await postYoutube({ youtubeUrl: YT_URL });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { audioUploadId: string };
    expect(body).toMatchObject({ source: "youtube", url: YT_URL });
    // The row keeps the origin URL, for history and for fetching again after
    // a restart.
    expect(await db.select().from(AudioTranscriptionJobs)).toEqual([
      expect.objectContaining({
        audioUploadId: body.audioUploadId,
        source: "youtube",
        YT_sourceUrl: YT_URL,
        YT_useCaptionsIfAvailable: false,
      }),
    ]);
    expect(mockPublish).toHaveBeenCalledWith("yt_fetch", {
      audioUploadId: body.audioUploadId,
      url: YT_URL,
      useCaptionsIfAvailable: false,
    });
  });

  it("passes the caption preference to the fetch, and stores it", async () => {
    const res = await postYoutube({
      youtubeUrl: YT_URL,
      useCaptionsIfAvailable: true,
    });

    const body = (await res.json()) as { audioUploadId: string };
    expect(mockPublish).toHaveBeenCalledWith("yt_fetch", {
      audioUploadId: body.audioUploadId,
      url: YT_URL,
      useCaptionsIfAvailable: true,
    });
    expect(await db.select().from(AudioTranscriptionJobs)).toEqual([
      expect.objectContaining({ YT_useCaptionsIfAvailable: true }),
    ]);
  });
});
