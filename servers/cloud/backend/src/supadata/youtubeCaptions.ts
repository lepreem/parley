/**
 * YouTube captions through Supadata (https://supadata.ai), which fetches them
 * from its own IPs: YouTube blocks this server's, a datacenter's. Every request
 * spends one of the plan's monthly credits, whatever the video's length, and so
 * does an answer that the video has no captions; one for a video that doesn't
 * exist does not.
 */
import {
  Supadata,
  SupadataError,
  type TranscriptChunk,
  type TranscriptOrJobId,
} from "@supadata/js";
import type { TranscriptSegment } from "@parley/server-kit/transcription/transcript";
import { logger } from "@parley/server-kit/runtime/logger";
import { getEnv } from "../env";

const log = logger.child({ component: "supadata" });

/** Answers took 1 to 7 seconds when measured, on videos up to two hours long. */
const TIMEOUT_MS = 60_000;

/**
 * The free plan answers one request a second, so a burst gets
 * "limit-exceeded". Waits grow and are spread at random, so the fetches that
 * collided don't all come back together.
 */
const ATTEMPTS = 5;
const RETRY_BACKOFF_MS = 1_000;

/** Shown to the person as the job's error. */
export const CAPTIONS_MESSAGES = {
  noCaptions:
    "This video has no captions, and Parley can't download YouTube audio yet. Upload the audio or video file instead.",
  notFound: "This video doesn't exist, or YouTube won't show it.",
  usedUp:
    "Parley has used this month's YouTube allowance. Upload the audio or video file instead.",
  /** Still refused after every retry: a long burst, or possibly credits run out. */
  busy: "Parley is fetching too many YouTube videos right now, or has used this month's allowance. Try again later, or upload the audio or video file.",
  unavailable: "YouTube captions are unavailable right now. Try again later.",
} as const;

/** A fetch that failed for a reason the person should be told. */
export class CaptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptionsError";
  }
}

let client: Supadata | undefined;
function supadata() {
  client ??= new Supadata({
    apiKey: getEnv().SUPADATA_API_KEY,
    baseUrl: apiUrl(),
  });
  return client;
}

/** The load test points this at its stand-in. */
function apiUrl() {
  return getEnv().SUPADATA_BASE_URL ?? "https://api.supadata.ai/v1";
}

/** Startup check: throws if the key is wrong. Spends no credit. */
async function ping(): Promise<void> {
  const response = await fetch(`${apiUrl()}/me`, {
    headers: { "x-api-key": getEnv().SUPADATA_API_KEY },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Supadata answered ${response.status}`);
}

class Timeout extends Error {}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Timeout("timed out")), TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Worth another try: Supadata's rate limit, its own failures (the SDK reports
 * a non-JSON answer as "internal-error"), and the network.
 */
function isTransient(error: unknown): boolean {
  if (error instanceof SupadataError) {
    return error.error === "limit-exceeded" || error.error === "internal-error";
  }
  return true;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getTranscript(url: string): Promise<TranscriptOrJobId> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTimeout(
        supadata().transcript({
          url,
          // Only captions YouTube already has: the other modes have Supadata
          // transcribe the audio itself, at a credit per half minute.
          mode: "native",
          // Parley is English first. A video with no English track answers in
          // the language it has, which is the one spoken: German news came
          // back German.
          lang: "en",
        }),
      );
    } catch (error) {
      if (attempt >= ATTEMPTS || !isTransient(error)) throw error;
      log.warn("Supadata failed, retrying", { attempt, url, error });
      await sleep(RETRY_BACKOFF_MS * attempt + Math.random() * 1_000);
    }
  }
}

/**
 * Seen once, on a rain video with captions disabled: rather than saying there
 * were none, Supadata answered with one invented English sentence about a
 * cabin by a lake. Its timing was in seconds (9.9) where every real answer
 * gives whole milliseconds, which is what gives it away.
 */
function isMadeUp(content: TranscriptChunk[]): boolean {
  return content.some(
    ({ offset, duration }) =>
      !Number.isInteger(offset ?? 0) || !Number.isInteger(duration ?? 0),
  );
}

/**
 * The video's captions, one segment per caption line in seconds, and their
 * language; or null when it has none. Throws CaptionsError for a failure the
 * person should hear about.
 */
async function fetchCaptions(
  url: string,
): Promise<{ segments: TranscriptSegment[]; language: string } | null> {
  let answer: TranscriptOrJobId;
  try {
    answer = await getTranscript(url);
  } catch (error) {
    if (error instanceof SupadataError) {
      if (error.error === "transcript-unavailable") return null;
      if (error.error === "not-found") {
        throw new CaptionsError(CAPTIONS_MESSAGES.notFound);
      }
      // Untested, since no account here has run out: the plan wants upgrading.
      if (error.error === "upgrade-required") {
        log.error("Supadata credits are used up", { url, error });
        throw new CaptionsError(CAPTIONS_MESSAGES.usedUp);
      }
      if (error.error === "limit-exceeded") {
        log.error("Supadata still refused after retries", { url, error });
        throw new CaptionsError(CAPTIONS_MESSAGES.busy);
      }
    }
    log.error("Supadata failed", { url, error });
    throw new CaptionsError(CAPTIONS_MESSAGES.unavailable);
  }

  if ("jobId" in answer) {
    // A transcription Supadata runs itself, which "native" should never start.
    log.error("Supadata started a job", { url, jobId: answer.jobId });
    throw new CaptionsError(CAPTIONS_MESSAGES.unavailable);
  }
  const { content, lang } = answer;
  if (!Array.isArray(content)) {
    log.error("Supadata sent no caption lines", { url });
    throw new CaptionsError(CAPTIONS_MESSAGES.unavailable);
  }
  if (isMadeUp(content)) {
    log.warn("Supadata made up captions", { url, content });
    return null;
  }

  const segments = content
    .filter((line) => line.text?.trim())
    .map((line) => ({
      start: line.offset / 1000,
      end: (line.offset + line.duration) / 1000,
      text: line.text.trim(),
    }));
  return segments.length ? { segments, language: lang } : null;
}

export const youtubeCaptions = { ping, fetchCaptions };
