import { beforeEach, describe, expect, it, vi } from "vitest";

const instances = vi.hoisted(() => [] as FakeFFmpeg[]);

class FakeFFmpeg {
  loaded = false;
  terminate = vi.fn(() => {
    this.loaded = false;
  });
  load = vi.fn(async () => {
    this.loaded = true;
  });
  constructor() {
    instances.push(this);
  }
}

vi.mock("@ffmpeg/ffmpeg", () => ({
  FFmpeg: vi.fn(function () {
    return new FakeFFmpeg();
  }),
}));
vi.mock("@ffmpeg/core?url", () => ({ default: "core.js" }));
vi.mock("@ffmpeg/core/wasm?url", () => ({ default: "core.wasm" }));

/** Each case gets its own module: the worker and queue live in there. */
async function freshWithFFmpeg() {
  vi.resetModules();
  instances.length = 0;
  return (await import("./ffmpeg")).withFFmpeg;
}

describe("withFFmpeg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never runs a job cancelled while it waited", async () => {
    const withFFmpeg = await freshWithFFmpeg();
    const task = vi.fn();

    const run = withFFmpeg(task, AbortSignal.abort(new Error("cancelled")));

    await expect(run).rejects.toThrow("cancelled");
    expect(task).not.toHaveBeenCalled();
  });

  it("ends the worker under a running job, and the next job loads a new one", async () => {
    const withFFmpeg = await freshWithFFmpeg();
    const controller = new AbortController();
    let stopRunning: (reason: Error) => void = () => {};

    const running = withFFmpeg(
      () =>
        new Promise((_, reject) => {
          stopRunning = reject;
          controller.abort();
        }),
      controller.signal,
    );
    await vi.waitFor(() => expect(instances[0]?.terminate).toHaveBeenCalled());
    stopRunning(new Error("called FFmpeg.terminate()"));
    await expect(running).rejects.toThrow("terminate");

    const next = vi.fn(async (ff: unknown) => ff);
    const usedBy = await withFFmpeg(next);

    expect(instances).toHaveLength(2);
    expect(usedBy).toBe(instances[1]);
  });

  it("leaves the worker alone once its job has finished", async () => {
    const withFFmpeg = await freshWithFFmpeg();
    const controller = new AbortController();

    await withFFmpeg(async () => "done", controller.signal);
    controller.abort();

    expect(instances[0]?.terminate).not.toHaveBeenCalled();
  });
});
