/** A file's speech-to-text, from Deepgram, and Deepgram's list of models. */

import { DeepgramClient } from "@deepgram/sdk";
import type { TranscriptSegment } from "@parley/server-kit/transcription/transcript";
import { getEnv } from "../../env";

const deepgram = new DeepgramClient({
  apiKey: getEnv().DEEPGRAM_API_KEY,
  // The load test's stand-in; unset, the SDK uses Deepgram itself.
  baseUrl: getEnv().DEEPGRAM_BASE_URL,
});

/**
 * Deepgram transcribes a multi-hour file in one job, but a long one can take
 * minutes to come back — far past the SDK's default timeout. Retries are held
 * to one because every attempt is billed for the full audio duration.
 */
const TRANSCRIBE_TIMEOUT_SECONDS = 20 * 60;
const TRANSCRIBE_MAX_RETRIES = 1;

/** Startup health check: fails if Deepgram is unreachable or rejects the API key. */
export async function ping(): Promise<void> {
  await deepgram.auth.v1.tokens.grant();
}

/** What Deepgram heard in a file, and in what language. */
export type Transcription = {
  /** Deepgram's utterances, each a stretch of speech between pauses. */
  segments: TranscriptSegment[];
  /** The language Deepgram detected ("de", "ar"); null if it named none. */
  language: string | null;
};

/**
 * The audio at `audioUrl`, transcribed in the language it's spoken in.
 * Deepgram detects the language first: without that it assumes English and
 * turns anything else into English that was never said.
 */
export async function transcribe(
  model: string,
  audioUrl: string,
  abortSignal: AbortSignal,
): Promise<Transcription> {
  const response = await deepgram.listen.v1.media.transcribeUrl(
    {
      url: audioUrl,
      model,
      detect_language: true,
      smart_format: true,
      utterances: true,
    },
    {
      timeoutInSeconds: TRANSCRIBE_TIMEOUT_SECONDS,
      maxRetries: TRANSCRIBE_MAX_RETRIES,
      abortSignal,
    },
  );

  // The response type also covers the callback mode, which answers with just a
  // request id. We never pass `callback`, so a body without results is a bug
  // rather than something to poll for.
  if (!("results" in response)) {
    throw new Error("Deepgram returned no transcription results");
  }

  return {
    segments: (response.results.utterances ?? []).map((utterance) => ({
      start: utterance.start ?? 0,
      end: utterance.end ?? utterance.start ?? 0,
      text: utterance.transcript ?? "",
    })),
    language: response.results.channels[0]?.detected_language || null,
  };
}

/**
 * Every speech-to-text model Deepgram lists, once per version, language set
 * and mode.
 */
export async function listModels() {
  const response = await deepgram.manage.v1.models.list();

  return (response.stt ?? []).flatMap((model) => {
    const id = model.canonical_name ?? model.name;
    if (!id) return [];
    return [
      {
        name: model.name ?? id,
        canonicalName: id,
        architecture: model.architecture,
        languages: model.languages,
        version: model.version,
        uuid: model.uuid,
        batch: model.batch,
        streaming: model.streaming,
        formattedOutput: model.formatted_output,
      },
    ];
  });
}
