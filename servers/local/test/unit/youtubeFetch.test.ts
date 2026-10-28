import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockProbe, mockDownloadAudio, mockWrite, mockPublish } = vi.hoisted(
  () => ({
    mockProbe: vi.fn(),
    mockDownloadAudio: vi.fn(),
    mockWrite: vi.fn(),
    mockPublish: vi.fn(),
  }),
);

vi.mock("../../api/src/ytDlp", async (importActual) => ({
  ...(await importActual<typeof import("../../api/src/ytDlp")>()),
  ytDlp: { probe: mockProbe, downloadAudio: mockDownloadAudio },
}));

vi.mock("../../core/files", () => ({
  MAX_AUDIO_BYTES: 1_000,
  files: { write: mockWrite },
}));

vi.mock("../../core/message-queue/messageQueue", async (importActual) => ({
  ...(await importActual<
    typeof import("../../core/message-queue/messageQueue")
  >()),
  mq: {
    queues: (
      await importActual<
        typeof import("../../core/message-queue/messageQueue")
      >()
    ).QUEUES,
    publish: mockPublish,
  },
}));

import { YtDlpError } from "../../api/src/ytDlp";
import { fetchCaptions, handleYoutubeFetch } from "../../api/src/youtubeFetch";

const job = {
  audioUploadId: "11111111-1111-4111-8111-111111111111",
  url: "https://www.youtube.com/watch?v=abc",
  useCaptionsIfAvailable: false,
} as const;

/** A download that leaves these files, by name and size, in its directory. */
function downloads(files: Record<string, number>) {
  return async (_url: string, directory: string) => {
    for (const [name, bytes] of Object.entries(files)) {
      await writeFile(path.join(directory, name), Buffer.alloc(bytes));
    }
  };
}

/** A json3 caption track answering with these lines. */
/** A json3 track with one line a second, each a second long. */
function captionsAnswer(...lines: string[]) {
  return new Response(
    JSON.stringify({
      events: lines.map((utf8, i) => ({
        tStartMs: i * 1000,
        dDurationMs: 1000,
        segs: [{ utf8 }],
      })),
    }),
  );
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  mockProbe.mockResolvedValue({});
  mockDownloadAudio.mockImplementation(downloads({ "audio.webm": 10 }));
  mockWrite.mockResolvedValue(undefined);
  mockPublish.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function published(queue: string) {
  return mockPublish.mock.calls.filter(([name]) => name === queue);
}

describe("handleYoutubeFetch", () => {
  it("stores the audio under the job's id, then queues transcription", async () => {
    mockDownloadAudio.mockImplementation(downloads({ "audio.m4a": 10 }));

    await handleYoutubeFetch(job);

    expect(mockWrite).toHaveBeenCalledWith(
      { kind: "audio", uploadId: job.audioUploadId },
      expect.any(Buffer),
    );
    expect(published("transcribe")).toEqual([
      ["transcribe", { audioUploadId: job.audioUploadId }],
    ]);
  });

  it("refuses audio over the limit before downloading any", async () => {
    mockProbe.mockResolvedValue({ filesize: 2_000 });

    await expect(handleYoutubeFetch(job)).rejects.toThrow(
      "over the 1000-byte limit",
    );
    expect(mockDownloadAudio).not.toHaveBeenCalled();
  });

  it("adds up every stream the download would take", async () => {
    mockProbe.mockResolvedValue({
      requested_formats: [{ filesize: 600 }, { filesize_approx: 600 }],
    });

    await expect(handleYoutubeFetch(job)).rejects.toThrow("over the");
    expect(mockDownloadAudio).not.toHaveBeenCalled();
  });

  it("never stores a partial download", async () => {
    mockDownloadAudio.mockImplementation(downloads({ "audio.webm.part": 10 }));

    await expect(handleYoutubeFetch(job)).rejects.toThrow(
      "yt-dlp produced no audio",
    );
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("stores the finished file, not a leftover beside it", async () => {
    mockDownloadAudio.mockImplementation(
      downloads({ "audio.webm.part": 10, "audio.webm": 20 }),
    );

    await handleYoutubeFetch(job);

    expect(mockWrite.mock.calls[0][1]).toHaveLength(20);
  });

  it("refuses a download that came out over the limit when its size wasn't known", async () => {
    mockDownloadAudio.mockImplementation(downloads({ "audio.webm": 2_000 }));

    await expect(handleYoutubeFetch(job)).rejects.toThrow(
      "audio is 2000 bytes",
    );
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("sends the captions on instead of downloading, when asked and there are some", async () => {
    mockProbe.mockResolvedValue({
      subtitles: { en: [{ ext: "json3", url: "https://captions/en" }] },
    });
    fetchMock.mockResolvedValue(captionsAnswer("Hello", "there"));

    await handleYoutubeFetch({ ...job, useCaptionsIfAvailable: true });

    expect(published("caption_transcript")).toEqual([
      [
        "caption_transcript",
        {
          audioUploadId: job.audioUploadId,
          segments: [
            { start: 0, end: 1, text: "Hello" },
            { start: 1, end: 2, text: "there" },
          ],
        },
      ],
    ]);
    expect(mockDownloadAudio).not.toHaveBeenCalled();
    expect(published("transcribe")).toEqual([]);
  });

  it("doesn't look for captions unless asked", async () => {
    mockProbe.mockResolvedValue({
      subtitles: { en: [{ ext: "json3", url: "https://captions/en" }] },
    });

    await handleYoutubeFetch(job);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockDownloadAudio).toHaveBeenCalledOnce();
  });

  it("transcribes the audio when the video has no captions", async () => {
    await handleYoutubeFetch({ ...job, useCaptionsIfAvailable: true });

    expect(mockDownloadAudio).toHaveBeenCalledOnce();
    expect(published("transcribe")).toHaveLength(1);
  });

  it("reports a failure for the job, cut to 500 characters, and rethrows", async () => {
    mockDownloadAudio.mockRejectedValue(new Error("x".repeat(600)));

    await expect(handleYoutubeFetch(job)).rejects.toThrow();

    expect(published("yt_fetch_failed")).toEqual([
      [
        "yt_fetch_failed",
        {
          audioUploadId: job.audioUploadId,
          error: "x".repeat(500),
        },
      ],
    ]);
    expect(published("transcribe")).toEqual([]);
  });
});

describe("fetchCaptions", () => {
  it("takes the first uploaded track", async () => {
    mockProbe.mockResolvedValue({
      subtitles: {
        en: [{ ext: "json3", url: "https://captions/en" }],
        de: [{ ext: "json3", url: "https://captions/de" }],
      },
    });
    fetchMock.mockResolvedValue(captionsAnswer("Hello"));

    expect(await fetchCaptions(job.url)).toEqual([
      { start: 0, end: 1, text: "Hello" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith("https://captions/en");
  });

  it("takes the recognition in the video's own language over a translation", async () => {
    mockProbe.mockResolvedValue({
      automatic_captions: {
        de: [{ ext: "json3", url: "https://captions/de" }],
        "en-orig": [{ ext: "json3", url: "https://captions/en-orig" }],
      },
    });
    fetchMock.mockResolvedValue(captionsAnswer("Hello"));

    expect(await fetchCaptions(job.url)).toEqual([
      { start: 0, end: 1, text: "Hello" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith("https://captions/en-orig");
  });

  it("makes each caption line a segment, with when it's shown", async () => {
    mockProbe.mockResolvedValue({
      subtitles: { en: [{ ext: "json3", url: "https://captions/en" }] },
    });
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          events: [
            {
              tStartMs: 1500,
              dDurationMs: 2000,
              segs: [{ utf8: "we're" }, { utf8: " no" }],
            },
            { tStartMs: 3000, segs: [{ utf8: "\n" }] },
            {
              tStartMs: 3500,
              dDurationMs: 500,
              segs: [{ utf8: "strangers  " }],
            },
            {},
          ],
        }),
      ),
    );

    expect(await fetchCaptions(job.url)).toEqual([
      { start: 1.5, end: 3.5, text: "we're no" },
      { start: 3.5, end: 4, text: "strangers" },
    ]);
  });

  it("is null for an empty track", async () => {
    mockProbe.mockResolvedValue({
      subtitles: { en: [{ ext: "json3", url: "https://captions/en" }] },
    });
    fetchMock.mockResolvedValue(captionsAnswer("  ", "\n"));

    expect(await fetchCaptions(job.url)).toBeNull();
  });

  it("is null when the captions can't be fetched", async () => {
    mockProbe.mockResolvedValue({
      subtitles: { en: [{ ext: "json3", url: "https://captions/en" }] },
    });
    fetchMock.mockResolvedValue(new Response("", { status: 403 }));

    expect(await fetchCaptions(job.url)).toBeNull();
  });
});

describe("retrying a fetch", () => {
  // Only the backoff is faked: each attempt also does real file work, which
  // has to finish before the backoff even starts.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** How `promise` ends, skipping every backoff along the way. */
  async function settle(promise: Promise<unknown>) {
    let outcome: { value: unknown } | undefined;
    promise.then(
      () => (outcome = { value: "resolved" }),
      (error: unknown) => (outcome = { value: error }),
    );
    while (!outcome) {
      await new Promise((resolve) => setImmediate(resolve));
      vi.advanceTimersByTime(1_000);
    }
    return outcome.value;
  }

  it("runs the whole fetch again after a passing failure, until it works", async () => {
    mockDownloadAudio
      .mockRejectedValueOnce(new YtDlpError("ERROR: HTTP Error 403: Forbidden"))
      .mockRejectedValueOnce(new YtDlpError("ERROR: HTTP Error 403: Forbidden"))
      .mockImplementationOnce(downloads({ "audio.webm": 10 }));

    expect(await settle(handleYoutubeFetch(job))).toBe("resolved");
    // Each attempt probes again, for fresh download URLs.
    expect(mockProbe).toHaveBeenCalledTimes(3);
    expect(mockWrite).toHaveBeenCalledOnce();
  });

  it("gives up after three attempts", async () => {
    mockDownloadAudio.mockRejectedValue(
      new YtDlpError("ERROR: HTTP Error 403: Forbidden"),
    );

    expect(await settle(handleYoutubeFetch(job))).toBeInstanceOf(YtDlpError);
    expect(mockDownloadAudio).toHaveBeenCalledTimes(3);
  });

  it("doesn't retry a video that isn't there to fetch", async () => {
    mockDownloadAudio.mockRejectedValue(
      new YtDlpError("ERROR: [youtube] abc: Video unavailable"),
    );

    expect(await settle(handleYoutubeFetch(job))).toBeInstanceOf(YtDlpError);
    expect(mockDownloadAudio).toHaveBeenCalledOnce();
  });

  it("doesn't retry its own failures", async () => {
    mockProbe.mockResolvedValue({ filesize: 2_000 });

    expect(await settle(handleYoutubeFetch(job))).toBeInstanceOf(Error);
    expect(mockProbe).toHaveBeenCalledOnce();
  });
});
