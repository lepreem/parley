import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger, messageOf } from "@parley/server-kit/runtime/logger";
import { mq, type QueuePayloads } from "../../core/message-queue/messageQueue";
import { files, MAX_AUDIO_BYTES } from "../../core/files";
import type { TranscriptSegment } from "@parley/server-kit/transcription/transcript";
import { YtDlpError, ytDlp, type VideoInfo } from "./ytDlp";

const log = logger.child({ component: "youtube-fetch" });

/**
 * YouTube's media servers intermittently refuse a signed download URL with
 * 403, and keep refusing that same URL, so a retry runs the whole fetch again
 * to get fresh ones rather than repeating the request.
 */
const FETCH_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 2_000;

/**
 * Failures no amount of retrying fixes; retrying them only delays the job
 * being marked failed. Matched against the message, since yt-dlp reports
 * everything the same way.
 */
const PERMANENT_FAILURES = [
  "video unavailable",
  "private video",
  "removed by the uploader",
  "members-only",
  "sign in to confirm your age",
  "no video formats found",
  "unsupported url",
  "is not a valid url",
];

/** How much of a failure the job keeps to show the user. */
const MAX_ERROR_CHARS = 500;

/**
 * Only yt-dlp's own failures are worth another try. Ours (oversized audio, no
 * output file) come out the same every time.
 */
function isRetryable(error: unknown) {
  if (!(error instanceof YtDlpError)) return false;
  const message = error.message.toLowerCase();
  return !PERMANENT_FAILURES.some((marker) => message.includes(marker));
}

/**
 * The first uploaded caption track, or else the speech recognition in the
 * video's own language; never a machine translation. Null when there's
 * neither in a format this reads.
 */
function captionTrackUrl(info: VideoInfo): string | null {
  const uploaded = Object.values(info.subtitles ?? {})[0];
  const recognized = Object.entries(info.automatic_captions ?? {}).find(
    ([language]) => language.endsWith("-orig"),
  )?.[1];
  const track = uploaded ?? recognized;
  return track?.find((format) => format.ext === "json3")?.url ?? null;
}

type CaptionEvents = {
  events?: {
    tStartMs?: number;
    dDurationMs?: number;
    segs?: { utf8?: string }[];
  }[];
};

/**
 * The video's captions, one segment per caption line, or null when it has
 * none worth using, so the audio is transcribed instead. Even a many-hour
 * video's captions are a few hundred KB, small enough to travel in a queue
 * message.
 */
export async function fetchCaptions(
  url: string,
): Promise<TranscriptSegment[] | null> {
  try {
    const trackUrl = captionTrackUrl(await ytDlp.probe(url));
    if (!trackUrl) {
      log.info("No usable captions", { url });
      return null;
    }

    const response = await fetch(trackUrl);
    if (!response.ok) throw new Error(`captions answered ${response.status}`);
    const { events = [] } = (await response.json()) as CaptionEvents;
    const segments = events.flatMap(
      ({ tStartMs = 0, dDurationMs = 0, segs = [] }) => {
        const text = segs
          .map((seg) => seg.utf8 ?? "")
          .join("")
          .trim();
        return text
          ? [
              {
                start: tStartMs / 1000,
                end: (tStartMs + dDurationMs) / 1000,
                text,
              },
            ]
          : [];
      },
    );
    if (segments.length === 0) {
      log.info("Caption track was empty", { url });
      return null;
    }

    log.info("Fetched captions", { url, segments: segments.length });
    return segments;
  } catch (error) {
    // The audio is still there to transcribe.
    log.warn("Could not fetch captions", { url, error: messageOf(error) });
    return null;
  }
}

/** Downloads the audio and stores it under the job's id. */
async function fetchAndStoreAudio(audioUploadId: string, url: string) {
  // Probe first, so oversized audio is refused before any bytes move.
  const info = await ytDlp.probe(url);
  const expectedBytes = (info.requested_formats ?? [info]).reduce(
    (sum, format) => sum + (format.filesize ?? format.filesize_approx ?? 0),
    0,
  );
  if (expectedBytes > MAX_AUDIO_BYTES) {
    throw new Error(
      `audio is ~${expectedBytes} bytes, over the ${MAX_AUDIO_BYTES}-byte limit`,
    );
  }

  const directory = await mkdtemp(path.join(tmpdir(), "youtube-fetch-"));
  try {
    await ytDlp.downloadAudio(url, directory, MAX_AUDIO_BYTES);

    // An aborted download leaves a truncated *.part file behind; never
    // store one.
    const [fileName] = (await readdir(directory)).filter(
      (name) => !name.endsWith(".part") && !name.endsWith(".ytdl"),
    );
    if (!fileName) {
      throw new Error(
        `yt-dlp produced no audio (it may exceed the ${MAX_AUDIO_BYTES / (1024 * 1024)}MB limit, or the video may be unavailable)`,
      );
    }

    const file = path.join(directory, fileName);
    // The size up front can be missing or low, and yt-dlp can't stop a
    // download whose size it doesn't know.
    const { size } = await stat(file);
    if (size > MAX_AUDIO_BYTES) {
      throw new Error(
        `audio is ${size} bytes, over the ${MAX_AUDIO_BYTES}-byte limit`,
      );
    }

    log.info("Downloaded audio", { audioUploadId, size });
    await files.write(
      { kind: "audio", uploadId: audioUploadId },
      await readFile(file),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function fetchWithRetries(audioUploadId: string, url: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchAndStoreAudio(audioUploadId, url);
    } catch (error) {
      if (attempt === FETCH_ATTEMPTS || !isRetryable(error)) throw error;
      const backoffMs = RETRY_BACKOFF_MS * attempt;
      log.warn("Fetch failed; trying again", {
        audioUploadId,
        attempt,
        backoffMs,
        error: messageOf(error),
      });
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

/**
 * Turns a YouTube job into something to transcribe: its captions, when asked
 * for and there are any, sent on as the transcript; otherwise its audio,
 * stored under the job's id and queued for transcription. A failure is
 * reported for the job to be marked failed, then rethrown.
 */
export async function handleYoutubeFetch({
  audioUploadId,
  url,
  useCaptionsIfAvailable,
}: QueuePayloads[typeof mq.queues.YT_FETCH]) {
  try {
    const captions = useCaptionsIfAvailable ? await fetchCaptions(url) : null;
    if (captions) {
      mq.publish(mq.queues.CAPTION_TRANSCRIPT, {
        audioUploadId,
        segments: captions,
      });
      return;
    }

    await fetchWithRetries(audioUploadId, url);
  } catch (error) {
    mq.publish(mq.queues.YT_FETCH_FAILED, {
      audioUploadId,
      error: messageOf(error).slice(0, MAX_ERROR_CHARS),
    });
    throw error;
  }

  mq.publish(mq.queues.TRANSCRIBE, { audioUploadId });
  log.info("Fetched audio; queued transcription", { audioUploadId });
}
