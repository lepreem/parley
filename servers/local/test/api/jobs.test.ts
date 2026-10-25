import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockFindAudioJob,
  mockFindJobsPage,
  mockDeleteAudioJob,
  mockFindTranscripts,
  mockDeleteFiles,
} = vi.hoisted(() => ({
  mockFindAudioJob: vi.fn(),
  mockFindJobsPage: vi.fn(),
  mockDeleteAudioJob: vi.fn(),
  mockFindTranscripts: vi.fn(),
  mockDeleteFiles: vi.fn(),
}));

vi.mock("../../core/db", async () => ({
  db: {},
  ...(await import("../helpers/dbTableStubs")).tableStubs,
}));

vi.mock("../../core/data/jobs.data", async (importActual) => {
  const actual =
    await importActual<typeof import("../../core/data/jobs.data")>();
  return {
    ...actual,
    jobs: {
      ...actual.jobs,
      findAudioJob: mockFindAudioJob,
      findJobsPage: mockFindJobsPage,
      deleteAudioJob: mockDeleteAudioJob,
    },
  };
});

vi.mock("../../core/data/transcripts.data", async (importActual) => {
  const actual =
    await importActual<typeof import("../../core/data/transcripts.data")>();
  return {
    ...actual,
    transcripts: {
      ...actual.transcripts,
      findTranscripts: mockFindTranscripts,
    },
  };
});

vi.mock("../../core/ai/ai_transcribe_client", () => ({
  DEFAULT_TRANSCRIBE_MODEL: "small",
  listTranscribeModels: vi.fn(),
  isValidTranscribeModel: vi.fn(),
}));

vi.mock("../../core/message-queue/messageQueue", () => {
  const queues = {
    TRANSCRIBE: "transcribe",
    TRANSCRIBE_DONE: "transcribe_done",
    YT_FETCH: "yt_fetch",
    YT_FETCH_FAILED: "yt_fetch_failed",
  } as const;

  return {
    QUEUES: queues,
    mq: { queues, publish: vi.fn() },
  };
});

vi.mock("../../core/files", async (importActual) => {
  const actual = await importActual<typeof import("../../core/files")>();
  return { ...actual, files: { ...actual.files, delete: mockDeleteFiles } };
});

import { createApp } from "../../api/app";
import { originHeaders } from "../helpers/headers";

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
  mockDeleteAudioJob.mockResolvedValue(true);
  mockDeleteFiles.mockResolvedValue(undefined);
});

describe("GET /jobs/summarize/:audioUploadId", () => {
  it("is gone — summarization is a chat prompt now", async () => {
    const res = await (
      await createApp()
    ).request(`http://localhost/jobs/summarize/${audioUploadId}`, {
      headers: originHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /jobs/transcribe/:audioUploadId", () => {
  it("returns an audio job", async () => {
    mockFindAudioJob.mockResolvedValueOnce({
      ...audioJob,
      status: "processing",
    });

    const res = await (
      await createApp()
    ).request(`http://localhost/jobs/transcribe/${audioUploadId}`, {
      headers: originHeaders(),
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
      headers: originHeaders(),
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
    expect(mockFindTranscripts).toHaveBeenCalledWith([audioUploadId]);
  });

  it("revalidates an unchanged completed transcript with an ETag", async () => {
    mockFindAudioJob.mockResolvedValue(audioJob);
    mockFindTranscripts.mockResolvedValue(
      new Map([[audioUploadId, "the full transcript text"]]),
    );
    const app = await createApp();
    const url = `http://localhost/jobs/transcribe/${audioUploadId}`;

    const first = await app.request(url);
    const etag = first.headers.get("ETag");

    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();
    expect(first.headers.get("Cache-Control")).toBe("private, no-cache");

    const second = await app.request(url, {
      headers: { "If-None-Match": etag as string },
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
      headers: originHeaders(),
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
      headers: originHeaders(),
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

  it("returns 404 when there is no such audio job", async () => {
    mockFindAudioJob.mockResolvedValueOnce(null);
    const res = await (
      await createApp()
    ).request(`http://localhost/jobs/transcribe/${audioUploadId}`, {
      headers: originHeaders(),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "Job not found" });
  });
});

describe("DELETE /jobs/transcribe/:audioUploadId", () => {
  it("deletes the job and its audio", async () => {
    const res = await (
      await createApp()
    ).request(`http://localhost/jobs/transcribe/${audioUploadId}`, {
      method: "DELETE",
      headers: originHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("ETag")).toBeNull();
    expect(mockDeleteAudioJob).toHaveBeenCalledWith(audioUploadId);
    expect(mockDeleteFiles).toHaveBeenCalledWith([
      { kind: "audio", uploadId: audioUploadId },
    ]);
  });

  it("preserves a source that is linked to a message", async () => {
    mockDeleteAudioJob.mockResolvedValueOnce(false);

    const response = await (
      await createApp()
    ).request(`http://localhost/jobs/transcribe/${audioUploadId}`, {
      method: "DELETE",
      headers: originHeaders(),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      message: "Source is linked to a message or reserved for a response",
    });
    expect(mockDeleteFiles).not.toHaveBeenCalled();
  });

  it("deletes nothing when there is no such job", async () => {
    mockFindAudioJob.mockResolvedValueOnce(null);

    const res = await (
      await createApp()
    ).request(`http://localhost/jobs/transcribe/${audioUploadId}`, {
      method: "DELETE",
      headers: originHeaders(),
    });
    expect(res.status).toBe(200);
    expect(mockDeleteFiles).not.toHaveBeenCalled();
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
      headers: originHeaders(),
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

  it("returns the transcription jobs", async () => {
    mockFindJobsPage.mockResolvedValueOnce([jobRow]);
    const res = await (
      await createApp()
    ).request("http://localhost/jobs", {
      headers: originHeaders(),
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
    mockFindJobsPage.mockResolvedValueOnce(rows);
    const res = await (
      await createApp()
    ).request("http://localhost/jobs", {
      headers: originHeaders(),
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
