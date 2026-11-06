import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
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
 * The sha256 of each ffmpeg build ffmpeg-static 5.3.0 installs (its GitHub
 * release b6.1.1), as GitHub lists them, by `${platform}-${arch}`. Its install
 * script downloads the build from that release and checks nothing, and a
 * release's files can be replaced, so a build is checked before it first
 * runs. A new ffmpeg-static needs these updated.
 */
const FFMPEG_SHA256: Partial<Record<string, string>> = {
  "darwin-arm64":
    "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584",
  "darwin-x64":
    "ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894",
  "linux-arm":
    "0afba4a11110e6e402053e0fc14c33a7eb207d7a588688ae87dba471a0f06c71",
  "linux-arm64":
    "6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce",
  "linux-ia32":
    "c6472eb993612db72ca50893a34137ba11173e60a1a4c028d4660a3f755d2490",
  "linux-x64":
    "e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99",
  "win32-x64":
    "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00",
};

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * The ffmpeg at `binary`, once its sha256 is the one pinned for this
 * platform. One named by FFMPEG_BIN, ffmpeg-static's own override, is the
 * user's choice of ffmpeg and runs as it is.
 */
export async function checkedFfmpeg(
  binary: string | null,
  platform = `${process.platform}-${process.arch}`,
  override = process.env.FFMPEG_BIN,
): Promise<string> {
  if (!binary) {
    throw new AudioDecodeError("ffmpeg-static has no ffmpeg for this platform");
  }
  if (override) return binary;
  const expected = FFMPEG_SHA256[platform];
  if (!expected) {
    throw new AudioDecodeError(`No sha256 is pinned for ffmpeg on ${platform}`);
  }
  const actual = await sha256Of(binary);
  if (actual !== expected) {
    throw new AudioDecodeError(
      `${binary} isn't the ffmpeg expected: sha256 ${actual}, not ${expected}`,
    );
  }
  return binary;
}

let ffmpegChecked: Promise<string> | undefined;

/** ffmpeg-static's ffmpeg, checked the first time it's asked for. */
function ffmpeg(): Promise<string> {
  return (ffmpegChecked ??= checkedFfmpeg(ffmpegPath));
}

/**
 * The audio file at `audioPath` as Whisper takes it: 16kHz mono signed 16-bit
 * PCM. ffmpeg reads the format from the file's contents, and takes the audio
 * out of a video. Aborting `abortSignal` kills it and rejects with the
 * signal's reason.
 *
 * The ffmpeg is the build ffmpeg-static installs for this platform, so nobody
 * installs it by hand, checked against its pinned sha256.
 */
export async function decodeAudio(
  audioPath: string,
  abortSignal?: AbortSignal,
): Promise<Buffer> {
  const child = spawn(
    await ffmpeg(),
    [
      ...["-v", "error", "-nostdin", "-i", audioPath, "-vn"],
      ...["-f", "s16le", "-ac", "1", "-ar", String(SAMPLE_RATE), "-"],
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
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

/**
 * Startup check: fails if this platform's ffmpeg isn't the build expected or
 * can't run.
 */
export async function pingFfmpeg(): Promise<void> {
  const child = spawn(await ffmpeg(), ["-version"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    throw new AudioDecodeError(`ffmpeg -version exited with code ${code}`);
  }
}
