import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequeue, mockPublish } = vi.hoisted(() => ({
  mockRequeue: vi.fn(),
  mockPublish: vi.fn(),
}));

vi.mock("../../core/data", () => ({
  data: { jobs: { requeueUnfinishedAudioJobs: mockRequeue } },
}));

vi.mock("../../core/message-queue/messageQueue", async (importActual) => {
  const { QUEUES } =
    await importActual<
      typeof import("../../core/message-queue/messageQueue")
    >();
  return { mq: { queues: QUEUES, publish: mockPublish } };
});

import { resumeUnfinishedJobs } from "../../core/audioTranscription";

const audioUploadId = "11111111-1111-4111-8111-111111111111";
const unfinished = {
  audioUploadId,
  source: "audio",
  youtubeSourceUrl: null,
  useCaptionsIfAvailable: null,
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("resumeUnfinishedJobs", () => {
  it("fetches a YouTube job again, as it was asked for", async () => {
    mockRequeue.mockResolvedValue([
      {
        ...unfinished,
        source: "youtube",
        youtubeSourceUrl: "https://www.youtube.com/watch?v=abc",
        useCaptionsIfAvailable: true,
      },
    ]);

    await resumeUnfinishedJobs();

    expect(mockPublish.mock.calls).toEqual([
      [
        "yt_fetch",
        {
          audioUploadId,
          url: "https://www.youtube.com/watch?v=abc",
          useCaptionsIfAvailable: true,
        },
      ],
    ]);
  });

  it("transcribes an uploaded file again", async () => {
    mockRequeue.mockResolvedValue([unfinished]);

    await resumeUnfinishedJobs();

    expect(mockPublish.mock.calls).toEqual([["transcribe", { audioUploadId }]]);
  });

  it("fetches without captions when the job never said", async () => {
    mockRequeue.mockResolvedValue([
      {
        ...unfinished,
        source: "youtube",
        youtubeSourceUrl: "https://www.youtube.com/watch?v=abc",
      },
    ]);

    await resumeUnfinishedJobs();

    expect(mockPublish.mock.calls[0][1]).toMatchObject({
      useCaptionsIfAvailable: false,
    });
  });

  it("queues nothing when nothing was left unfinished", async () => {
    mockRequeue.mockResolvedValue([]);

    await resumeUnfinishedJobs();

    expect(mockPublish).not.toHaveBeenCalled();
  });
});
