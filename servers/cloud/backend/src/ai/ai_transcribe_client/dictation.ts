import { getEnv } from "../../env";

/**
 * The model a dictated message is transcribed with. Not Deepgram, which does a
 * file's transcription: asked to detect the language, it took spoken Arabic
 * for Spanish or Ukrainian and answered with nonsense or nothing, and someone
 * dictating has no way to name the language first. Whisper detected it, kept
 * colloquial Arabic as it was said, and answered empty on silence, at under a
 * fifth of the price.
 */
const DICTATION_MODEL = "openai/whisper-large-v3-turbo";

/** A dictated message is minutes at most, and someone is waiting on it. */
const DICTATION_TIMEOUT_MS = 2 * 60 * 1000;

/** "audio/webm;codecs=opus" to "webm": OpenRouter goes by the file's name. */
function extensionOf(contentType: string): string {
  return /^audio\/([a-z0-9]+)/i.exec(contentType)?.[1] ?? "webm";
}

/** A short recording, as text; empty if nobody spoke. */
export async function transcribeDictation(
  clip: Uint8Array<ArrayBuffer>,
  contentType: string,
): Promise<string> {
  const { OPENROUTER_API_KEY, OPENROUTER_BASE_URL } = getEnv();
  const form = new FormData();
  form.append(
    "file",
    new File([clip], `recording.${extensionOf(contentType)}`, {
      type: contentType,
    }),
  );
  form.append("model", DICTATION_MODEL);

  const response = await fetch(
    `${OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/audio/transcriptions`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(DICTATION_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`OpenRouter transcription failed: HTTP ${response.status}`);
  }
  const { text } = (await response.json()) as { text?: string };
  // Whisper starts with a space and puts two between its segments.
  return (text ?? "").replace(/\s+/g, " ").trim();
}
