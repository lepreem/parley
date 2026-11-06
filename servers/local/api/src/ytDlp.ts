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
 * Passed ahead of everything else on every run, so yt-dlp never acts as
 * anyone. It runs on people's own computers, where their browser's cookies,
 * or a yt-dlp config file of their own, would sign it in to their Google
 * account, and YouTube bans accounts it sees fetching like this. Each is
 * yt-dlp's default already; saying so keeps a config file, a plugin or a
 * later release (the desktop app updates yt-dlp by itself) from changing it.
 * test/integration/ytDlpSignedOut.test.ts checks it against the real yt-dlp.
 */
const SIGNED_OUT_ARGS = [
  // No config file: the person's, the system's, or one next to yt-dlp.
  "--ignore-config",
  // No plugins, such as the ones that sign in to YouTube with OAuth.
  "--no-plugin-dirs",
  "--no-cookies",
  "--no-cookies-from-browser",
];

/**
 * Options that would make yt-dlp act as someone, refused whatever passes
 * them. Never take one off this list to make YouTube work: a signed-in fetch
 * puts the person's Google account at risk.
 */
const SIGNED_IN_FLAGS = new Set([
  "--cookies",
  "--cookies-from-browser",
  "-u",
  "--username",
  "-p",
  "--password",
  "-2",
  "--twofactor",
  "-n",
  "--netrc",
  "--netrc-location",
  "--netrc-cmd",
  "--video-password",
  "--ap-mso",
  "--ap-username",
  "--ap-password",
  "--client-certificate",
  "--client-certificate-key",
  "--client-certificate-password",
  // A Cookie or Authorization header would sign in just the same.
  "--add-header",
  "--add-headers",
  // A config file or plugin could pass any of the above.
  "--config-location",
  "--config-locations",
  "--plugin-dirs",
]);

/** The first of `args` that would sign yt-dlp in, if any. */
export function signedInFlag(args: readonly string[]): string | undefined {
  return args.find((arg) => SIGNED_IN_FLAGS.has(arg.split("=", 1)[0]));
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

function run(
  args: readonly string[],
  abortSignal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const refused = signedInFlag(args);
    if (refused) {
      reject(
        new Error(`yt-dlp must never run signed in, so ${refused} is refused`),
      );
      return;
    }
    const child = spawn(
      getApiEnv().YT_DLP_PATH,
      [...SIGNED_OUT_ARGS, ...args],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        ...(abortSignal ? { signal: abortSignal } : {}),
      },
    );
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
async function probe(
  url: string,
  abortSignal?: AbortSignal,
): Promise<VideoInfo> {
  const json = await run(
    [...commonArgs(), "--dump-single-json", "--format", AUDIO_FORMAT, url],
    abortSignal,
  );
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
  abortSignal?: AbortSignal,
): Promise<void> {
  await run(
    [
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
    ],
    abortSignal,
  );
}

/** Startup health check: fails if yt-dlp can't be run. */
async function ping(): Promise<void> {
  await run(["--version"]);
}

export const ytDlp = { probe, downloadAudio, ping };
