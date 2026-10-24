import { describe, it, expect, vi, beforeEach } from "vitest";

const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

const {
  mockInsert,
  mockUpdate,
  mockUpdateSet,
  mockSendEvent,
  mockCreateUploadUrl,
  mockInspectUploadedObject,
  mockIsValidTranscribeModel,
  ledger,
} = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockSendEvent: vi.fn(),
  mockCreateUploadUrl: vi.fn(),
  mockInspectUploadedObject: vi.fn(),
  mockIsValidTranscribeModel: vi.fn(),
  ledger: {
    recordPendingUpload: vi.fn(),
    recordConfirmedObjects: vi.fn(),
    findLedgerEntry: vi.fn(),
    claim: vi.fn(),
    forgetObjects: vi.fn(),
  },
}));

const { mockListChatModels } = vi.hoisted(() => ({
  mockListChatModels: vi.fn(),
}));
vi.mock("../../src/ai/ai_chat_client", async (importActual) => {
  // importActual is the correct way to get real values inside vi.mock
  const actual =
    await importActual<typeof import("../../src/ai/ai_chat_client")>();
  return {
    ...actual,
    chat: { ...actual.chat, listModels: mockListChatModels },
  };
});

vi.mock("../../src/ai/ai_transcribe_client", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/ai/ai_transcribe_client")>();
  return {
    ...actual, // preserves DEFAULT_TRANSCRIBE_MODEL
    transcription: {
      ...actual.transcription,
      isValidModel: mockIsValidTranscribeModel,
    },
  };
});

vi.mock("../../src/db", async () => ({
  db: {
    insert: mockInsert,
    update: mockUpdate,
    // Job writes run in (nested) transactions; run them against the same
    // insert mock so those writes are recorded like plain ones.
    transaction: (run: (tx: unknown) => unknown) =>
      run({
        insert: mockInsert,
        transaction: (inner: (tx: unknown) => unknown) =>
          inner({ insert: mockInsert }),
      }),
  },
  ...(await import("../helpers/dbTableStubs")).tableStubs,
}));

// The ledger's SQL is covered by the integration tests; here it's the
// decisions made around it. A confirm that goes through runs its writes
// against the same insert mock as everything else.
vi.mock("../../src/data/storageLedger.data", () => ({
  storageLedger: {
    recordPendingUpload: ledger.recordPendingUpload,
    recordConfirmedObjects: ledger.recordConfirmedObjects,
    findLedgerEntry: ledger.findLedgerEntry,
    forgetObjects: ledger.forgetObjects,
    confirmUpload: async (
      entry: unknown,
      withinMs: number,
      write: (executor: unknown) => Promise<unknown>,
    ) => {
      if (!(await ledger.claim(entry, withinMs))) return false;
      await write({
        insert: mockInsert,
        transaction: (run: (tx: unknown) => unknown) =>
          run({ insert: mockInsert }),
      });
      return true;
    },
  },
}));

vi.mock("../../src/storage/bucket", () => ({
  // Literals (not the top-level consts): vi.mock factories can run during
  // import evaluation, before this module's own bindings initialize.
  AUDIO_BUCKET: "Audio",
  MAX_AUDIO_BYTES: 50 * 1024 * 1024,
  bucket: {
    createUploadUrl: mockCreateUploadUrl,
    inspectUploadedObject: mockInspectUploadedObject,
  },
}));

vi.mock("../../src/storage/sign", () => ({
  IMAGE_URL_TTL_SECONDS: 7 * 24 * 60 * 60,
  sign: {
    url: vi.fn(),
    urls: vi.fn(),
  },
}));

vi.mock("../../src/message-queue/messageQueue", () => ({
  mq: {
    queues: {
      TRANSCRIBE_AUDIO: "transcribe_audio",
      YT_FETCH_CAPTIONS: "yt_fetch_captions",
      YT_FETCH_AUDIO: "yt_fetch_audio",
    },
    publish: mockSendEvent,
  },
}));

import { createApp } from "../../src/app";
import { authedHeaders, sessionCookieHeader } from "../helpers/session";

async function postJson(path: string, body: unknown, userId = "user_01") {
  return (await createApp()).request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: await sessionCookieHeader(userId),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /upload/text", () => {
  it("is gone — summarization is a chat prompt now", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/upload/text", {
      method: "POST",
      headers: await authedHeaders("user_01"),
      body: new FormData(),
    });
    expect(res.status).toBe(404);
  });
});

const HOUR_MS = 60 * 60 * 1000;
const URL_LIFETIME_MS = 2 * HOUR_MS;

describe("POST /upload/audio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateUploadUrl.mockResolvedValue("https://storage.test/upload");
    ledger.recordPendingUpload.mockResolvedValue(undefined);
  });

  it("returns 401 without a session cookie", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/upload/audio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(401);
    expect(mockCreateUploadUrl).not.toHaveBeenCalled();
    expect(ledger.recordPendingUpload).not.toHaveBeenCalled();
  });

  it("records a pending upload and returns a URL bound to a fresh id", async () => {
    const res = await postJson("/upload/audio", {});

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      uploadId: string;
      signedUploadUrl: string;
    };
    expect(body.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.signedUploadUrl).toBe("https://storage.test/upload");
    const object = { kind: "audio", uploadId: body.uploadId };
    expect(mockCreateUploadUrl).toHaveBeenCalledWith("user_01", object);
    expect(ledger.recordPendingUpload).toHaveBeenCalledWith({
      userId: "user_01",
      ...object,
    });
    // No job yet: an upload that never lands leaves nothing in the sources.
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockSendEvent).not.toHaveBeenCalled();
  });

  // Otherwise an upload could land with nothing recording it.
  it("hands out no URL when the record can't be written", async () => {
    ledger.recordPendingUpload.mockRejectedValue(new Error("db down"));

    const res = await postJson("/upload/audio", {});

    expect(res.status).toBe(500);
    // The same JSON shape as every other error, with nothing internal in it.
    expect(await res.json()).toEqual({ message: "Internal server error" });
  });
});

describe("POST /upload/audio/confirm", () => {
  const UPLOAD_ID = "11111111-1111-4111-8111-111111111111";
  const entry = { userId: "user_01", kind: "audio", uploadId: UPLOAD_ID };
  let mockValues: ReturnType<typeof vi.fn>;

  function confirmBody(overrides: Record<string, unknown> = {}) {
    return {
      uploadId: UPLOAD_ID,
      fileName: "talk.webm",
      audioSource: "video",
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockValues = vi.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values: mockValues });
    mockUpdateSet.mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockSendEvent.mockResolvedValue(undefined);
    mockIsValidTranscribeModel.mockResolvedValue(true);
    ledger.findLedgerEntry.mockResolvedValue({
      status: "pending",
      createdAt: new Date(),
    });
    ledger.claim.mockResolvedValue(true);
    mockInspectUploadedObject.mockResolvedValue({
      ok: true,
      sizeBytes: 2048,
      contentType: "audio/webm",
    });
  });

  it("returns 401 without a session cookie", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/upload/audio/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(confirmBody()),
    });

    expect(res.status).toBe(401);
    expect(ledger.findLedgerEntry).not.toHaveBeenCalled();
  });

  it("returns 400 for an id that is not a uuid", async () => {
    const res = await postJson(
      "/upload/audio/confirm",
      confirmBody({ uploadId: "not-a-uuid" }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: "Invalid upload id" });
    expect(ledger.findLedgerEntry).not.toHaveBeenCalled();
  });

  it("returns 400 without a file name", async () => {
    const res = await postJson(
      "/upload/audio/confirm",
      confirmBody({ fileName: "  " }),
    );

    expect(res.status).toBe(400);
    expect(ledger.findLedgerEntry).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid source", async () => {
    const res = await postJson(
      "/upload/audio/confirm",
      confirmBody({ audioSource: "invalid" }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      message: 'Invalid source; use "video" or "audio" (or omit)',
    });
  });

  // Includes an id minted for an image: its record has the other kind.
  it("returns 404 for an id with no audio upload recorded", async () => {
    ledger.findLedgerEntry.mockResolvedValue(undefined);

    const res = await postJson("/upload/audio/confirm", confirmBody());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      message: "No uploaded audio to confirm",
    });
    expect(ledger.findLedgerEntry).toHaveBeenCalledWith(entry);
    expect(mockInspectUploadedObject).not.toHaveBeenCalled();
  });

  it("returns 404 for an upload whose object was deleted", async () => {
    ledger.findLedgerEntry.mockResolvedValue({
      status: "deleted",
      createdAt: new Date(),
    });

    const res = await postJson("/upload/audio/confirm", confirmBody());

    expect(res.status).toBe(404);
    expect(ledger.claim).not.toHaveBeenCalled();
  });

  it("returns 409 for an upload already confirmed", async () => {
    ledger.findLedgerEntry.mockResolvedValue({
      status: "confirmed",
      createdAt: new Date(),
    });

    const res = await postJson("/upload/audio/confirm", confirmBody());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      message: "This upload was already confirmed",
    });
    expect(mockSendEvent).not.toHaveBeenCalled();
  });

  it("returns 404 when nothing has landed yet", async () => {
    mockInspectUploadedObject.mockResolvedValue({
      ok: false,
      reason: "missing",
    });

    const res = await postJson("/upload/audio/confirm", confirmBody());

    expect(res.status).toBe(404);
    expect(ledger.claim).not.toHaveBeenCalled();
  });

  it("returns 410 for an upload handed out longer ago than the window", async () => {
    ledger.findLedgerEntry.mockResolvedValue({
      status: "pending",
      createdAt: new Date(Date.now() - URL_LIFETIME_MS - 1000),
    });

    const res = await postJson("/upload/audio/confirm", confirmBody());

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      message: "This upload has expired; upload the file again",
    });
    expect(mockInspectUploadedObject).not.toHaveBeenCalled();
    expect(ledger.claim).not.toHaveBeenCalled();
  });

  it("still confirms an upload just inside the window", async () => {
    ledger.findLedgerEntry.mockResolvedValue({
      status: "pending",
      createdAt: new Date(Date.now() - URL_LIFETIME_MS + 60_000),
    });

    const res = await postJson("/upload/audio/confirm", confirmBody());

    expect(res.status).toBe(200);
  });

  // A rejected upload writes nothing; the sweep removes it later.
  it("returns 400 for an object that is not audio, touching nothing", async () => {
    mockInspectUploadedObject.mockResolvedValue({
      ok: false,
      reason: "wrong-type",
      contentType: "application/zip",
      maxBytes: MAX_AUDIO_BYTES,
    });

    const res = await postJson("/upload/audio/confirm", confirmBody());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      message: "Expected an audio file, got: application/zip",
    });
    expect(ledger.claim).not.toHaveBeenCalled();
    expect(ledger.forgetObjects).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockSendEvent).not.toHaveBeenCalled();
  });

  it("names the type as unknown when storage recorded none", async () => {
    mockInspectUploadedObject.mockResolvedValue({
      ok: false,
      reason: "wrong-type",
      contentType: "",
      maxBytes: MAX_AUDIO_BYTES,
    });

    const res = await postJson("/upload/audio/confirm", confirmBody());

    expect(await res.json()).toEqual({
      message: "Expected an audio file, got: unknown",
    });
  });

  it("returns 413 for an object over the cap, touching nothing", async () => {
    mockInspectUploadedObject.mockResolvedValue({
      ok: false,
      reason: "too-large",
      contentType: "audio/webm",
      maxBytes: MAX_AUDIO_BYTES,
    });

    const res = await postJson("/upload/audio/confirm", confirmBody());

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      message: "Audio file is too large",
      maxBytes: MAX_AUDIO_BYTES,
    });
    expect(ledger.claim).not.toHaveBeenCalled();
    expect(mockSendEvent).not.toHaveBeenCalled();
  });

  it("confirms the upload with the job's rows, then queues transcription", async () => {
    const res = await postJson("/upload/audio/confirm", confirmBody());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      audioUploadId: UPLOAD_ID,
      fileName: "talk.webm",
      size: 2048,
      mimeType: "audio/webm",
      source: "video",
    });
    expect(mockInspectUploadedObject).toHaveBeenCalledWith("user_01", {
      kind: "audio",
      uploadId: UPLOAD_ID,
    });
    expect(ledger.claim).toHaveBeenCalledWith(entry, URL_LIFETIME_MS);
    // The attachment row, then the job row, inside the confirm.
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentId: UPLOAD_ID,
        kind: "audio",
        userId: "user_01",
        fileName: "talk.webm",
        mimeType: "audio/webm",
        sizeBytes: 2048,
      }),
    );
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        audioUploadId: UPLOAD_ID,
        source: "video",
      }),
    );
    expect(mockSendEvent).toHaveBeenCalledWith("transcribe_audio", {
      audioUploadId: UPLOAD_ID,
    });
  });

  it("defaults the source to audio", async () => {
    const res = await postJson(
      "/upload/audio/confirm",
      confirmBody({ audioSource: undefined }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: "audio" });
  });

  // Two confirms at once: both find it pending, only one confirms it.
  it("returns 409 and queues nothing when another confirm got there first", async () => {
    ledger.claim.mockResolvedValue(false);

    const res = await postJson("/upload/audio/confirm", confirmBody());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      message: "This upload was already confirmed",
    });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockSendEvent).not.toHaveBeenCalled();
  });

  // Otherwise the job would sit queued with no worker ever coming for it.
  it("fails the job when its queue publish doesn't go through", async () => {
    mockSendEvent.mockRejectedValueOnce(new Error("broker down"));

    const res = await postJson("/upload/audio/confirm", confirmBody());

    expect(res.status).toBe(500);
    expect(mockUpdateSet).toHaveBeenCalledWith({
      status: "failed",
      error: "Could not be queued for processing",
    });
  });

  it("fails loudly and queues nothing when the job can't be written", async () => {
    mockValues.mockRejectedValueOnce(new Error("connection reset"));

    const res = await postJson("/upload/audio/confirm", confirmBody());

    expect(res.status).toBe(500);
    expect(mockSendEvent).not.toHaveBeenCalled();
  });
});

describe("POST /upload/youtube", () => {
  const YT_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  // Captured so we can assert the inserted row (e.g. YT_sourceUrl) directly.
  let mockValues: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockValues = vi.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values: mockValues });
    mockUpdateSet.mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockSendEvent.mockResolvedValue(undefined);
    mockIsValidTranscribeModel.mockResolvedValue(true);
  });

  it("returns 401 without a session cookie", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/upload/youtube", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ youtubeUrl: YT_URL }),
    });
    expect(res.status).toBe(401);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(ledger.recordConfirmedObjects).not.toHaveBeenCalled();
    expect(mockSendEvent).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-YouTube URL", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/upload/youtube", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: await sessionCookieHeader("user_01"),
      },
      body: JSON.stringify({ youtubeUrl: "https://example.com/watch?v=x" }),
    });
    expect(res.status).toBe(400);
    // The schema's own message must reach the client, not a generic string.
    expect(await res.json()).toEqual({ message: "Not a valid YouTube URL" });
    expect(mockSendEvent).not.toHaveBeenCalled();
  });

  it("creates a job and enqueues fetch with the url + userId", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/upload/youtube", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: await sessionCookieHeader("user_01"),
      },
      body: JSON.stringify({ youtubeUrl: YT_URL }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      message: string;
      source: string;
      url: string;
      audioUploadId: string;
    };
    expect(body.source).toBe("youtube");
    expect(body.url).toBe(YT_URL);
    expect(typeof body.audioUploadId).toBe("string");
    // The attachment row, then the job row.
    expect(mockInsert).toHaveBeenCalledTimes(2);
    // The row persists the origin URL (for history + future transcript caching).
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "youtube",
        YT_sourceUrl: YT_URL,
      }),
    );
    // The fetch event carries the url + userId the fetcher needs (bucket write
    // happens in Python; the API only enqueues).
    // What the fetcher will write is on record before it's asked to.
    expect(ledger.recordConfirmedObjects).toHaveBeenCalledWith(
      "user_01",
      [{ kind: "audio", uploadId: body.audioUploadId }],
      expect.anything(),
    );
    expect(mockSendEvent).toHaveBeenCalledWith("yt_fetch_audio", {
      audioUploadId: body.audioUploadId,
      url: YT_URL,
      userId: "user_01",
    });
  });

  it("fails the job when its fetch publish doesn't go through", async () => {
    mockSendEvent.mockRejectedValueOnce(new Error("broker down"));

    const res = await (
      await createApp()
    ).request("http://localhost/upload/youtube", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: await sessionCookieHeader("user_01"),
      },
      body: JSON.stringify({ youtubeUrl: YT_URL }),
    });

    expect(res.status).toBe(500);
    expect(mockUpdateSet).toHaveBeenCalledWith({
      status: "failed",
      error: "Could not be queued for processing",
    });
  });

  it("sends a caption preference to the fetcher's captions queue", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/upload/youtube", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: await sessionCookieHeader("user_01"),
      },
      body: JSON.stringify({
        youtubeUrl: YT_URL,
        useCaptionsIfAvailable: true,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { audioUploadId: string };
    // The captions come back in the fetcher's message, so nothing is
    // reserved for them here.
    expect(ledger.recordConfirmedObjects).toHaveBeenCalledWith(
      "user_01",
      [{ kind: "audio", uploadId: body.audioUploadId }],
      expect.anything(),
    );
    expect(mockSendEvent).toHaveBeenCalledWith("yt_fetch_captions", {
      audioUploadId: body.audioUploadId,
      url: YT_URL,
      userId: "user_01",
    });
  });
});
