import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockFindAudioJob,
  mockFindUserJobsPage,
  mockDeleteAudioJob,
  mockFindTranscripts,
  mockDeleteObjects,
} = vi.hoisted(() => ({
  mockFindAudioJob: vi.fn(),
  mockFindUserJobsPage: vi.fn(),
  mockDeleteAudioJob: vi.fn(),
  mockFindTranscripts: vi.fn(),
  mockDeleteObjects: vi.fn(),
}));

vi.mock("../../src/db", async () => ({
  db: {},
  ...(await import("../helpers/dbTableStubs")).tableStubs,
}));

vi.mock("../../src/data/jobs.data", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/data/jobs.data")>();
  return {
    ...actual,
    jobs: {
      ...actual.jobs,
      findAudioJob: mockFindAudioJob,
      findUserJobsPage: mockFindUserJobsPage,
      deleteAudioJob: mockDeleteAudioJob,
    },
  };
});

vi.mock("../../src/data/transcripts.data", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/data/transcripts.data")>();
  return {
    ...actual,
    transcripts: {
      ...actual.transcripts,
      findTranscripts: mockFindTranscripts,
    },
  };
});

vi.mock("../../src/ai/ai_transcribe_client", () => ({
  DEFAULT_TRANSCRIBE_MODEL: "nova-3",
  getTranscribeModelData: vi.fn(),
  transcription: { isValidModel: vi.fn() },
}));

vi.mock("../../src/message-queue/messageQueue", () => {
  const queues = {
    TRANSCRIBE_AUDIO: "transcribe_audio",
    FETCH_YOUTUBE_CAPTIONS: "fetch_youtube_captions",
    FETCH_YOUTUBE_AUDIO: "fetch_youtube_audio",
    FAIL_YOUTUBE_JOB: "fail_youtube_job",
  } as const;

  return {
    QUEUES: queues,
    mq: { queues, publish: vi.fn() },
  };
});

vi.mock("../../src/uploads", () => ({
  uploads: { deleteObjects: mockDeleteObjects },
}));

vi.mock("../../src/storage/bucket", () => ({
  bucket: {},
}));

vi.mock("../../src/storage/sign", () => ({
  IMAGE_URL_TTL_SECONDS: 7 * 24 * 60 * 60,
  sign: {
    urls: vi.fn(),
  },
}));

import { createApp } from "../../src/app";
import { authedHeaders, sessionCookieHeader } from "../helpers/session";

const audioUploadId = "550e8400-e29b-41d4-a716-446655440000";

const audioJob = {
  audioUploadId,
  fileName: "clip.mp3",
  source: "audio",
  youtubeSourceUrl: null,
  status: "completed",
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindAudioJob.mockResolvedValue(audioJob);
  mockFindTranscripts.mockResolvedValue(new Map());
  mockDeleteAudioJob.mockResolvedValue({ fetchMayStillWrite: false });
  mockDeleteObjects.mockResolvedValue(undefined);
});

describe("GET /jobs/summarize/:audioUploadId", () => {
  it("is gone — summarization is a chat prompt now", async () => {
    const res = await (
      await createApp()
    ).request(`http://localhost/jobs/summarize/${audioUploadId}`, {
      headers: await authedHeaders("user_01OWNER"),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /jobs/transcribe/:audioUploadId", () => {
  it("returns an audio job for the owner", async () => {
    mockFindAudioJob.mockResolvedValueOnce({
      ...audioJob,
      status: "processing",
    });

    const res = await (
      await createApp()
    ).request(`http://localhost/jobs/transcribe/${audioUploadId}`, {
      headers: await authedHeaders("user_01OWNER"),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      audioUploadId,
      fileName: "clip.mp3",
      source: "audio",
      status: "processing",
      transcript: null,
      error: null,
    });
  });

  it("returns the transcript once the job has completed", async () => {
    mockFindAudioJob.mockResolvedValueOnce(audioJob);
    mockFindTranscripts.mockResolvedValueOnce(
      new Map([[audioUploadId, "the full transcript text"]]),
    );

    const res = await (
      await createApp()
    ).request(`http://localhost/jobs/transcribe/${audioUploadId}`, {
      headers: await authedHeaders("user_01OWNER"),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      audioUploadId,
      fileName: "clip.mp3",
      source: "audio",
      status: "completed",
      transcript: "the full transcript text",
      error: null,
    });
    expect(mockFindTranscripts).toHaveBeenCalledWith("user_01OWNER", [
      audioUploadId,
    ]);
  });

  it("revalidates an unchanged completed transcript with an ETag", async () => {
    mockFindAudioJob.mockResolvedValue(audioJob);
    mockFindTranscripts.mockResolvedValue(
      new Map([[audioUploadId, "the full transcript text"]]),
    );
    const app = await createApp();
    const cookie = await sessionCookieHeader("user_01OWNER");
    const url = `http://localhost/jobs/transcribe/${audioUploadId}`;

    const first = await app.request(url, {
      headers: { Cookie: cookie },
    });
    const etag = first.headers.get("ETag");

    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();
    expect(first.headers.get("Cache-Control")).toBe("private, no-cache");

    const second = await app.request(url, {
      headers: { Cookie: cookie, "If-None-Match": etag as string },
    });

    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("Cache-Control")).toBe("private, no-cache");
  });

  it("reports no transcript while the job hasn't produced one", async () => {
    mockFindAudioJob.mockResolvedValueOnce({ ...audioJob, status: "queued" });
    mockFindTranscripts.mockResolvedValueOnce(new Map());

    const res = await (
      await createApp()
    ).request(`http://localhost/jobs/transcribe/${audioUploadId}`, {
      headers: await authedHeaders("user_01OWNER"),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { transcript: null }).transcript).toBeNull();
  });

  it("degrades to a null transcript when the transcript read fails", async () => {
    mockFindAudioJob.mockResolvedValueOnce(audioJob);
    mockFindTranscripts.mockRejectedValueOnce(new Error("db exploded"));

    const res = await (
      await createApp()
    ).request(`http://localhost/jobs/transcribe/${audioUploadId}`, {
      headers: await authedHeaders("user_01OWNER"),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      audioUploadId,
      fileName: "clip.mp3",
      source: "audio",
      status: "completed",
      transcript: null,
      error: null,
    });
  });

  it("returns 404 when no audio job exists for the user", async () => {
    mockFindAudioJob.mockResolvedValueOnce(null);
    const res = await (
      await createApp()
    ).request(`http://localhost/jobs/transcribe/${audioUploadId}`, {
      headers: await authedHeaders("user_01OTHER"),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "Job not found" });
  });

  it("returns 401 without a session cookie", async () => {
    const res = await (
      await createApp()
    ).request(`http://localhost/jobs/transcribe/${audioUploadId}`);
    expect(res.status).toBe(401);
    expect(mockFindAudioJob).not.toHaveBeenCalled();
  });
});

describe("DELETE /jobs/transcribe/:audioUploadId", () => {
  it("deletes the job and its audio", async () => {
    const res = await (
      await createApp()
    ).request(`http://localhost/jobs/transcribe/${audioUploadId}`, {
      method: "DELETE",
      headers: await authedHeaders("user_01OWNER"),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("ETag")).toBeNull();
    expect(mockDeleteAudioJob).toHaveBeenCalledWith(
      "user_01OWNER",
      audioUploadId,
    );
    expect(mockDeleteObjects).toHaveBeenCalledWith("user_01OWNER", [
      { kind: "audio", uploadId: audioUploadId },
    ]);
  });

  // The fetcher is another process; deleting the job doesn't stop it, so its
  // objects stay on record for the sweep rather than being released now.
  it("releases nothing while a youtube fetch could still write", async () => {
    mockDeleteAudioJob.mockResolvedValueOnce({ fetchMayStillWrite: true });

    const res = await (
      await createApp()
    ).request(`http://localhost/jobs/transcribe/${audioUploadId}`, {
      method: "DELETE",
      headers: await authedHeaders("user_01OWNER"),
    });

    expect(res.status).toBe(200);
    expect(mockDeleteObjects).not.toHaveBeenCalled();
  });

  it("preserves a source that is linked to a message", async () => {
    mockDeleteAudioJob.mockResolvedValueOnce(null);

    const response = await (
      await createApp()
    ).request(`http://localhost/jobs/transcribe/${audioUploadId}`, {
      method: "DELETE",
      headers: await authedHeaders("user_01OWNER"),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      message: "Source is linked to a message or reserved for a response",
    });
    expect(mockDeleteObjects).not.toHaveBeenCalled();
  });

  it("scopes the delete to the requesting user", async () => {
    mockFindAudioJob.mockResolvedValueOnce(null);

    const res = await (
      await createApp()
    ).request(`http://localhost/jobs/transcribe/${audioUploadId}`, {
      method: "DELETE",
      headers: await authedHeaders("user_01INTRUDER"),
    });
    expect(res.status).toBe(200);
    expect(mockDeleteObjects).not.toHaveBeenCalled();
    expect(mockDeleteAudioJob).not.toHaveBeenCalled();
  });
});

describe("removed transcript rerun routes", () => {
  it.each([
    `/jobs/transcribe/${audioUploadId}/rerun`,
    `/jobs/youtube/${audioUploadId}/rerun`,
  ])("returns 404 for POST %s", async (path) => {
    const response = await (
      await createApp()
    ).request(`http://localhost${path}`, {
      method: "POST",
      headers: await authedHeaders("user_01OWNER"),
    });

    expect(response.status).toBe(404);
  });
});

describe("GET /jobs", () => {
  const jobRow = {
    audioUploadId: "550e8400-e29b-41d4-a716-44665544000a",
    fileName: "lecture.mp3",
    source: "audio",
    status: "completed",
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    error: null,
  };

  it("returns the user's transcription jobs", async () => {
    mockFindUserJobsPage.mockResolvedValueOnce([jobRow]);
    const res = await (
      await createApp()
    ).request("http://localhost/jobs", {
      headers: await authedHeaders("user_01OWNER"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jobs: { audioUploadId: string }[];
      nextCursor: string | null;
    };
    expect(body.jobs.map((job) => job.audioUploadId)).toEqual([
      jobRow.audioUploadId,
    ]);
    expect(body.nextCursor).toBeNull();
  });

  it("issues a cursor when the over-fetch shows another page", async () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({
      ...jobRow,
      audioUploadId: `550e8400-e29b-41d4-a716-4466554400${String(index).padStart(2, "0")}`,
    }));
    mockFindUserJobsPage.mockResolvedValueOnce(rows);
    const res = await (
      await createApp()
    ).request("http://localhost/jobs", {
      headers: await authedHeaders("user_01OWNER"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jobs: unknown[];
      nextCursor: string | null;
    };
    expect(body.jobs).toHaveLength(20);
    expect(body.nextCursor).toBeTruthy();
  });
});
