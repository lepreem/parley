import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockTranscript } = vi.hoisted(() => ({ mockTranscript: vi.fn() }));

vi.mock("@supadata/js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supadata/js")>();
  return {
    ...actual,
    Supadata: vi.fn(function () {
      return { transcript: mockTranscript };
    }),
  };
});

import { Supadata, SupadataError } from "@supadata/js";
import {
  CAPTIONS_MESSAGES,
  CaptionsError,
  youtubeCaptions,
} from "../../src/supadata";

const URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const refusal = (error: SupadataError["error"]) =>
  new SupadataError({ error, message: error, details: "" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  mockTranscript.mockReset();
});

/** Runs the fetch to its end, through any waits between retries. */
async function fetchCaptions() {
  const result = youtubeCaptions.fetchCaptions(URL).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  return result;
}

describe("fetchCaptions", () => {
  it("turns caption lines into segments in seconds", async () => {
    mockTranscript.mockResolvedValue({
      content: [
        { text: " Never gonna ", offset: 1200, duration: 1800, lang: "en" },
        { text: "give you up", offset: 3000, duration: 2000, lang: "en" },
      ],
      lang: "en",
      availableLangs: ["en"],
    });

    expect(await fetchCaptions()).toEqual({
      value: {
        segments: [
          { start: 1.2, end: 3, text: "Never gonna" },
          { start: 3, end: 5, text: "give you up" },
        ],
        language: "en",
      },
    });
  });

  it("asks only for captions YouTube already has, in English first", async () => {
    mockTranscript.mockResolvedValue({ content: [], lang: "en" });

    await fetchCaptions();

    expect(mockTranscript).toHaveBeenCalledWith({
      url: URL,
      mode: "native",
      lang: "en",
    });
    expect(Supadata).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "test-key" }),
    );
  });

  it("is nothing for a video without captions", async () => {
    mockTranscript.mockRejectedValue(refusal("transcript-unavailable"));
    expect(await fetchCaptions()).toEqual({ value: null });
  });

  it("is nothing when every line is blank", async () => {
    mockTranscript.mockResolvedValue({
      content: [{ text: "  ", offset: 0, duration: 1000, lang: "en" }],
      lang: "en",
    });
    expect(await fetchCaptions()).toEqual({ value: null });
  });

  // Seen on a rain video with captions disabled.
  it("is nothing for captions Supadata made up, timed in seconds", async () => {
    mockTranscript.mockResolvedValue({
      content: [
        {
          text: "The wind whipped through the branches",
          offset: 0,
          duration: 9.9,
          lang: "en",
        },
      ],
      lang: "en",
    });
    expect(await fetchCaptions()).toEqual({ value: null });
  });

  it("says a video doesn't exist", async () => {
    mockTranscript.mockRejectedValue(refusal("not-found"));
    expect(await fetchCaptions()).toEqual({
      error: new CaptionsError(CAPTIONS_MESSAGES.notFound),
    });
    expect(mockTranscript).toHaveBeenCalledOnce();
  });

  it("says when this month's credits are used up", async () => {
    mockTranscript.mockRejectedValue(refusal("upgrade-required"));
    expect(await fetchCaptions()).toEqual({
      error: new CaptionsError(CAPTIONS_MESSAGES.usedUp),
    });
    expect(mockTranscript).toHaveBeenCalledOnce();
  });

  it("waits out the rate limit", async () => {
    mockTranscript
      .mockRejectedValueOnce(refusal("limit-exceeded"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({
        content: [{ text: "hi", offset: 0, duration: 1000, lang: "en" }],
        lang: "en",
      });

    expect(await fetchCaptions()).toMatchObject({
      value: { segments: [{ text: "hi" }] },
    });
    expect(mockTranscript).toHaveBeenCalledTimes(3);
  });

  it("gives up on a rate limit that doesn't clear", async () => {
    mockTranscript.mockRejectedValue(refusal("limit-exceeded"));
    expect(await fetchCaptions()).toEqual({
      error: new CaptionsError(CAPTIONS_MESSAGES.busy),
    });
    expect(mockTranscript).toHaveBeenCalledTimes(5);
  });

  it("gives up on a Supadata that stays down", async () => {
    mockTranscript.mockRejectedValue(new TypeError("fetch failed"));
    expect(await fetchCaptions()).toEqual({
      error: new CaptionsError(CAPTIONS_MESSAGES.unavailable),
    });
    expect(mockTranscript).toHaveBeenCalledTimes(5);
  });

  it("doesn't retry a refusal that won't change, such as a wrong key", async () => {
    mockTranscript.mockRejectedValue(refusal("unauthorized"));
    expect(await fetchCaptions()).toEqual({
      error: new CaptionsError(CAPTIONS_MESSAGES.unavailable),
    });
    expect(mockTranscript).toHaveBeenCalledOnce();
  });

  it("gives up on an answer that never comes", async () => {
    mockTranscript.mockReturnValue(new Promise(() => {}));
    expect(await fetchCaptions()).toEqual({
      error: new CaptionsError(CAPTIONS_MESSAGES.unavailable),
    });
    expect(mockTranscript).toHaveBeenCalledTimes(5);
  });

  it("fails rather than wait on a transcription Supadata started itself", async () => {
    mockTranscript.mockResolvedValue({ jobId: "job_1" });
    expect(await fetchCaptions()).toEqual({
      error: new CaptionsError(CAPTIONS_MESSAGES.unavailable),
    });
  });
});
