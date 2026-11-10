import { beforeEach, describe, expect, it, vi } from "vitest";

const audioUploadId = "550e8400-e29b-41d4-a716-446655440000" as const;
const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const mocks = vi.hoisted(() => ({
  findAudioJob: vi.fn(),
  failAudioJobById: vi.fn(),
  fetchCaptions: vi.fn(),
  handleTranscribeJob: vi.fn(),
  sendEvent: vi.fn(),
}));

vi.mock("../../src/data", () => ({
  data: {
    jobs: {
      findAudioJob: mocks.findAudioJob,
      failAudioJobById: mocks.failAudioJobById,
    },
  },
}));

vi.mock("../../src/supadata/youtubeCaptions", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/supadata/youtubeCaptions")
  >()),
  youtubeCaptions: { fetchCaptions: mocks.fetchCaptions },
}));

vi.mock("../../src/transcription/transcribeJob", () => ({
  handleTranscribeJob: mocks.handleTranscribeJob,
}));

vi.mock("../../src/sse/hub", () => ({
  eventHub: { send: mocks.sendEvent },
}));

import { handleYoutubeCaptionsJob } from "../../src/transcription/youtubeCaptionsJob";
import { CAPTIONS_MESSAGES, CaptionsError } from "../../src/supadata";

const message = { audioUploadId, userId: "user_01", url };
const delivery = { attempt: 1, lastAttempt: false, redelivered: false };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findAudioJob.mockResolvedValue({ status: "queued" });
});

describe("handleYoutubeCaptionsJob", () => {
  it("saves the captions as the transcript", async () => {
    const captions = {
      segments: [{ start: 0, end: 2, text: "Never gonna give you up" }],
      language: "en",
    };
    mocks.fetchCaptions.mockResolvedValue(captions);

    await handleYoutubeCaptionsJob(message, delivery);

    expect(mocks.fetchCaptions).toHaveBeenCalledWith(url);
    expect(mocks.handleTranscribeJob).toHaveBeenCalledWith(
      { audioUploadId, ...captions },
      delivery,
    );
    expect(mocks.failAudioJobById).not.toHaveBeenCalled();
  });

  it.each([null, { status: "completed" }])(
    "spends no credit on a job deleted or done while it waited: %o",
    async (job) => {
      mocks.findAudioJob.mockResolvedValue(job);

      await handleYoutubeCaptionsJob(message, delivery);

      expect(mocks.findAudioJob).toHaveBeenCalledWith("user_01", audioUploadId);
      expect(mocks.fetchCaptions).not.toHaveBeenCalled();
    },
  );

  it("fails a video without captions, saying to upload the file", async () => {
    mocks.fetchCaptions.mockResolvedValue(null);

    await handleYoutubeCaptionsJob(message, delivery);

    expect(mocks.failAudioJobById).toHaveBeenCalledWith(
      audioUploadId,
      CAPTIONS_MESSAGES.noCaptions,
    );
    expect(mocks.sendEvent).toHaveBeenCalledWith("user_01", "jobUpdated", {
      audioUploadId,
    });
    expect(mocks.handleTranscribeJob).not.toHaveBeenCalled();
  });

  it("fails the job with what went wrong", async () => {
    mocks.fetchCaptions.mockRejectedValue(
      new CaptionsError(CAPTIONS_MESSAGES.notFound),
    );

    await handleYoutubeCaptionsJob(message, delivery);

    expect(mocks.failAudioJobById).toHaveBeenCalledWith(
      audioUploadId,
      CAPTIONS_MESSAGES.notFound,
    );
  });

  it("fails the job, rather than leave it queued, on anything unexpected", async () => {
    mocks.fetchCaptions.mockRejectedValue(new Error("boom"));

    await handleYoutubeCaptionsJob(message, delivery);

    expect(mocks.failAudioJobById).toHaveBeenCalledWith(
      audioUploadId,
      CAPTIONS_MESSAGES.unavailable,
    );
  });
});
