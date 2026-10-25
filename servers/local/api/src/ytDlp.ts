import { spawn } from "node:child_process";
import { getApiEnv } from "../../core/env";

/** yt-dlp exited unsuccessfully; the message is the last error it printed. */
export class YtDlpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YtDlpError";
  }
}

/**
 * Lowest-bitrate audio-only stream: speech-to-text downsamples to 16kHz mono,
 * so anything above ~48kbps is discarded work.
 */
const AUDIO_FORMAT = "worstaudio/bestaudio/best";

/**
 * Passed on every run. YouTube signs its media URLs with a parameter that has
 * to be descrambled by running its player JavaScript; yt-dlp does that with
 * this process's own Node. From a home connection YouTube asks for nothing
 * more: no proof-of-origin token, no particular player client.
 */
function commonArgs() {
  return [
    "--no-playlist",
    "--js-runtimes",
    `node:${process.execPath}`,
    // A stalled connection shouldn't hold a fetch hostage; yt-dlp retries
    // after a timeout.
    "--socket-timeout",
    "30",
  ];
}

function run(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(getApiEnv().YT_DLP_PATH, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout);
      const lastError = stderr
        .trim()
        .split("\n")
        .findLast((line) => line.startsWith("ERROR:"));
      reject(new YtDlpError(lastError ?? `yt-dlp exited with code ${code}`));
    });
  });
}

type CaptionFormat = { ext: string; url: string };
type FormatSize = { filesize?: number | null; filesize_approx?: number | null };

/** The parts of yt-dlp's video metadata a fetch reads. */
export type VideoInfo = FormatSize & {
  /** Uploaded caption tracks by language, in YouTube's order. */
  subtitles?: Record<string, CaptionFormat[]>;
  /**
   * Generated tracks by language: the speech recognition in the video's own
   * language, under a key ending "-orig", and its machine translations.
   */
  automatic_captions?: Record<string, CaptionFormat[]>;
  /** Present when the chosen format is several streams. */
  requested_formats?: FormatSize[];
};

/** The video's metadata, with the audio format a download would pick. */
async function probe(url: string): Promise<VideoInfo> {
  const json = await run([
    ...commonArgs(),
    "--dump-single-json",
    "--format",
    AUDIO_FORMAT,
    url,
  ]);
  return JSON.parse(json) as VideoInfo;
}

/**
 * Downloads the audio into `directory` as `audio.<ext>`. yt-dlp aborts when
 * the size is known up front to be over `maxBytes`, leaving a partial file.
 */
async function downloadAudio(
  url: string,
  directory: string,
  maxBytes: number,
): Promise<void> {
  await run([
    ...commonArgs(),
    "--quiet",
    "--no-warnings",
    "--format",
    AUDIO_FORMAT,
    "--output",
    `${directory}/audio.%(ext)s`,
    "--max-filesize",
    String(maxBytes),
    // YouTube's media servers can refuse downloads that aren't ranged.
    "--http-chunk-size",
    "1M",
    url,
  ]);
}

/** Startup health check: fails if yt-dlp can't be run. */
async function ping(): Promise<void> {
  await run(["--version"]);
}

export const ytDlp = { probe, downloadAudio, ping };
