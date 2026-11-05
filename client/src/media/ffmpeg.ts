import { FFmpeg } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";

let ffmpeg: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg?.loaded) return ffmpeg;
  if (!loadPromise) {
    const ff = new FFmpeg();
    loadPromise = (async () => {
      await ff.load({ coreURL, wasmURL });
      ffmpeg = ff;
      return ff;
    })();
  }
  return loadPromise;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * One FFmpeg instance serves the whole app, with one virtual filesystem and one
 * exec at a time — so dropping several recordings at once has to queue rather
 * than have each overwrite the others' input file mid-run. A failed job doesn't
 * hold up the next one.
 *
 * Aborting `signal` skips a job still waiting. One already running can only be
 * stopped by ending the worker it runs in, so the next job loads a new one.
 */
export function withFFmpeg<T>(
  task: (ff: FFmpeg) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const attempt = async () => {
    signal?.throwIfAborted();
    const ff = await getFFmpeg();
    signal?.throwIfAborted();

    const stop = () => {
      ffmpeg = null;
      loadPromise = null;
      ff.terminate();
    };
    signal?.addEventListener("abort", stop, { once: true });
    try {
      return await task(ff);
    } finally {
      signal?.removeEventListener("abort", stop);
    }
  };

  const run = queue.then(attempt, attempt);
  queue = run.catch(() => undefined);
  return run;
}
