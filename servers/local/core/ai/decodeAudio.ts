import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

/** The rate Whisper hears at, in samples a second. */
export const SAMPLE_RATE = 16_000;

/** ffmpeg couldn't read the file; the message is the last error it printed. */
class AudioDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioDecodeError";
  }
}

/**
 * The audio file at `audioPath` as Whisper takes it: 16kHz mono signed 16-bit
 * PCM. ffmpeg reads the format from the file's contents, and takes the audio
 * out of a video. Aborting `abortSignal` kills it and rejects with the
 * signal's reason.
 *
 * The ffmpeg is the build ffmpeg-static installs for this platform, so nobody
 * installs it by hand.
 */
export async function decodeAudio(
  audioPath: string,
  abortSignal?: AbortSignal,
): Promise<Buffer> {
  if (!ffmpegPath) {
    throw new AudioDecodeError("ffmpeg-static has no ffmpeg for this platform");
  }
  const child = spawn(
    ffmpegPath,
    [
      ...["-v", "error", "-nostdin", "-i", audioPath, "-vn"],
      ...["-f", "s16le", "-ac", "1", "-ar", String(SAMPLE_RATE), "-"],
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      ...(abortSignal ? { signal: abortSignal } : {}),
    },
  );

  // A run that can't start, or is killed, reports why here; it still closes.
  let failure: unknown;
  child.on("error", (error) => (failure ??= error));
  const closed = new Promise<number | null>((resolve) =>
    child.on("close", resolve),
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));

  const chunks: Buffer[] = [];
  for await (const chunk of child.stdout) chunks.push(chunk as Buffer);
  const code = await closed;

  if (abortSignal?.aborted) throw abortSignal.reason;
  if (failure) throw failure;
  if (code !== 0) {
    throw new AudioDecodeError(
      stderr.trim().split("\n").at(-1) || `ffmpeg exited with code ${code}`,
    );
  }
  return Buffer.concat(chunks);
}

/** Startup check: fails if this platform's ffmpeg can't run. */
export async function pingFfmpeg(): Promise<void> {
  if (!ffmpegPath) {
    throw new AudioDecodeError("ffmpeg-static has no ffmpeg for this platform");
  }
  const child = spawn(ffmpegPath, ["-version"], { stdio: "ignore" });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    throw new AudioDecodeError(`ffmpeg -version exited with code ${code}`);
  }
}
