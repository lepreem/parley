import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  decodeAudio: vi.fn(),
  pingFfmpeg: vi.fn(),
  modelFile: vi.fn(),
  loadWhisperModule: vi.fn(),
  initWhisper: vi.fn(),
  initWhisperVad: vi.fn(),
}));

vi.mock("../../core/ai/decodeAudio", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  decodeAudio: mocks.decodeAudio,
  pingFfmpeg: mocks.pingFfmpeg,
}));
vi.mock("../../core/ai/modelFiles", () => ({ modelFile: mocks.modelFile }));
vi.mock("@fugood/whisper.node", () => ({
  loadWhisperModule: mocks.loadWhisperModule,
  initWhisper: mocks.initWhisper,
  initWhisperVad: mocks.initWhisperVad,
  addNativeLogListener: vi.fn(),
  toggleNativeLog: vi.fn(async () => {}),
}));

import {
  pingTranscribeAI,
  transcribeAI,
} from "../../core/ai/ai_transcribe_client";

/** 16kHz 16-bit PCM, `seconds` long. */
const pcmOf = (seconds: number) => Buffer.alloc(seconds * 16_000 * 2);

type Segment = { t0: number; t1: number; text: string };
type Step = { afterMs?: number; segment: Segment };

/**
 * A whisper.cpp context that finishes each step's segment after its delay,
 * then resolves with them all (or, with `end: false`, stalls until stopped).
 */
function fakeWhisper(steps: Step[], { end = true } = {}) {
  const context = {
    transcribeData: vi.fn(
      (_pcm: ArrayBuffer, options: { onNewSegments?: () => void }) => {
        let stopped: () => void = () => {};
        const promise = new Promise((resolve) => {
          const done: Segment[] = [];
          stopped = () => resolve({ segments: done, isAborted: true });
          void (async () => {
            for (const step of steps) {
              if (step.afterMs) {
                await new Promise((r) => setTimeout(r, step.afterMs));
              }
              done.push(step.segment);
              options.onNewSegments?.();
            }
            if (end) resolve({ segments: done, isAborted: false });
          })();
        });
        context.stop.mockImplementation(async () => stopped());
        return { stop: context.stop, promise };
      },
    ),
    stop: vi.fn(),
    release: vi.fn(async () => {}),
  };
  return context;
}

/** A voice detection context that finds speech where `spans` say, in cs. */
function fakeVad(spans: { t0: number; t1: number }[]) {
  return {
    detectSpeechData: vi.fn(async () => spans),
    release: vi.fn(async () => {}),
  };
}

const transcribe = () => transcribeAI("/data/audios/talk");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.decodeAudio.mockResolvedValue(pcmOf(20));
  mocks.modelFile.mockImplementation(
    async ({ name }: { name: string }) => `/models/${name}`,
  );
  mocks.loadWhisperModule.mockResolvedValue({});
  mocks.initWhisperVad.mockResolvedValue(fakeVad([{ t0: 0, t1: 2000 }]));
});

describe("pingTranscribeAI", () => {
  it("loads the binding and runs ffmpeg", async () => {
    await pingTranscribeAI();

    expect(mocks.loadWhisperModule).toHaveBeenCalled();
    expect(mocks.pingFfmpeg).toHaveBeenCalled();
  });
});

describe("transcribeAI", () => {
  it("transcribes the decoded audio with Whisper Small's ggml file", async () => {
    const whisper = fakeWhisper([
      { segment: { t0: 0, t1: 2000, text: " Hello." } },
    ]);
    mocks.initWhisper.mockResolvedValue(whisper);

    expect(await transcribe()).toEqual([{ start: 0, end: 2, text: " Hello." }]);

    expect(mocks.decodeAudio).toHaveBeenCalledWith(
      "/data/audios/talk",
      expect.any(AbortSignal),
    );
    expect(mocks.modelFile).toHaveBeenCalledWith(
      {
        name: "ggml-small.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin",
        sha256:
          "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
      },
      expect.any(AbortSignal),
    );
    expect(mocks.initWhisper).toHaveBeenCalledWith({
      filePath: "/models/ggml-small.bin",
      useGpu: true,
    });
    expect(whisper.release).toHaveBeenCalled();
  });

  it("detects the language rather than assuming English", async () => {
    const whisper = fakeWhisper([]);
    mocks.initWhisper.mockResolvedValue(whisper);

    await transcribe();

    expect(whisper.transcribeData.mock.calls[0]?.[1]).toMatchObject({
      language: "auto",
    });
  });

  it("transcribes only the speech, timed against the original audio", async () => {
    // Speech from 5s to 7s and from 12s to 13s, in hundredths of a second.
    mocks.initWhisperVad.mockResolvedValue(
      fakeVad([
        { t0: 500, t1: 700 },
        { t0: 1200, t1: 1300 },
      ]),
    );
    // In the shortened audio the second stretch starts at 2.1s, after the
    // first's 2s and a 0.1s gap.
    const whisper = fakeWhisper([
      { segment: { t0: 0, t1: 2000, text: " First." } },
      { segment: { t0: 2100, t1: 3100, text: " After a pause." } },
    ]);
    mocks.initWhisper.mockResolvedValue(whisper);

    expect(await transcribe()).toEqual([
      { start: 5, end: 7, text: " First." },
      { start: 12, end: 13, text: " After a pause." },
    ]);
    const [pcm] = whisper.transcribeData.mock.calls[0]!;
    expect(pcm.byteLength).toBe(3.1 * 16_000 * 2);
  });

  it("is empty for audio with no speech, without loading Whisper", async () => {
    mocks.initWhisperVad.mockResolvedValue(fakeVad([]));

    expect(await transcribe()).toEqual([]);
    expect(mocks.initWhisper).not.toHaveBeenCalled();
  });

  it("fails when the file can't be decoded", async () => {
    mocks.decodeAudio.mockRejectedValue(new Error("Invalid data"));

    await expect(transcribe()).rejects.toThrow("Invalid data");
  });

  it("fails when a model can't be downloaded", async () => {
    mocks.modelFile.mockRejectedValue(new Error("HTTP 404"));

    await expect(transcribe()).rejects.toThrow("HTTP 404");
  });

  it("releases the model when transcription fails", async () => {
    const whisper = fakeWhisper([]);
    whisper.transcribeData.mockReturnValue({
      stop: vi.fn(),
      promise: Promise.reject(new Error("native failure")),
    });
    mocks.initWhisper.mockResolvedValue(whisper);

    await expect(transcribe()).rejects.toThrow("native failure");
    expect(whisper.release).toHaveBeenCalled();
  });
});

describe("transcribeAI timeouts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const MINUTE = 60_000;

  it("waits for the model to download before the first segment", async () => {
    mocks.initWhisper.mockResolvedValue(
      fakeWhisper([
        { afterMs: 29 * MINUTE, segment: { t0: 0, t1: 1000, text: " Hi." } },
      ]),
    );
    const result = transcribe();

    await vi.advanceTimersByTimeAsync(29 * MINUTE);
    expect(await result).toEqual([{ start: 0, end: 1, text: " Hi." }]);
  });

  it("gives up on a run that stalls between segments, and stops it", async () => {
    const whisper = fakeWhisper(
      [{ segment: { t0: 0, t1: 1000, text: " Hi." } }],
      { end: false },
    );
    mocks.initWhisper.mockResolvedValue(whisper);
    const result = transcribe();
    const failed = expect(result).rejects.toMatchObject({
      name: "TimeoutError",
      message: "No progress for 600000 ms",
    });

    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await failed;
    expect(whisper.stop).toHaveBeenCalled();
    expect(whisper.release).toHaveBeenCalled();
  });
});
