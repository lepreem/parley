import {
  addNativeLogListener,
  initWhisper,
  initWhisperVad,
  loadWhisperModule,
  toggleNativeLog,
} from "@fugood/whisper.node";
import type { TranscribeModel } from "@parley/contract";
import { logger } from "@parley/server-kit/runtime/logger";
import { withTimeout } from "@parley/server-kit/runtime/withTimeout";
import type { TranscriptSegment } from "@parley/server-kit/transcription/transcript";
import { decodeAudio, pingFfmpeg } from "./decodeAudio";
import { modelFile } from "./modelFiles";
import { type Span, speechOnly } from "./speechOnly";

const log = logger.child({ component: "whisper" });

/**
 * Transcription runs on this machine, with whisper.cpp through
 * @fugood/whisper.node, whose prebuilt binding npm installs for this platform:
 * Metal on Apple Silicon, the CPU elsewhere. ffmpeg decodes the file first,
 * and voice detection cuts out the silences.
 */

/** Whisper models, in whisper.cpp's format, by the name the catalog uses. */
const whisperModel = (id: string) => ({
  name: `ggml-${id}.bin`,
  url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${id}.bin`,
});

/** Silero, the voice detection model whisper.cpp runs. */
const VAD_MODEL = {
  name: "ggml-silero-v6.2.0.bin",
  url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
};

/**
 * Loads the binding, once. whisper.cpp prints its every step to stderr unless
 * it's given somewhere else to log, so only its errors reach the logs.
 */
let loaded: Promise<void> | undefined;
function loadWhisper() {
  loaded ??= (async () => {
    await loadWhisperModule();
    addNativeLogListener((level, text) => {
      if (level === "error") log.warn(text.trim());
    });
    await toggleNativeLog(true);
  })();
  return loaded;
}

/**
 * Where there's speech in `pcm`. Pauses up to two seconds stay in, with
 * speech padded by 400ms either side, as faster-whisper's voice detection
 * did, so no word is clipped.
 */
async function detectSpeech(pcm: Buffer, vadPath: string): Promise<Span[]> {
  const vad = await initWhisperVad({ filePath: vadPath, useGpu: false });
  try {
    const segments = await vad.detectSpeechData(arrayBufferOf(pcm), {
      minSilenceDurationMs: 2000,
      speechPadMs: 400,
    });
    // whisper.cpp times voice detection in hundredths of a second.
    return segments.map(({ t0, t1 }) => ({ startMs: t0 * 10, endMs: t1 * 10 }));
  } finally {
    await vad.release();
  }
}

/** The bytes of `buffer`, as the binding takes them. */
function arrayBufferOf(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

/**
 * Startup health check: fails if the binding or ffmpeg can't load on this
 * machine. Models aren't fetched here; the first transcription downloads its
 * own.
 */
export async function pingTranscribeAI(): Promise<void> {
  await Promise.all([loadWhisper(), pingFfmpeg()]);
}

// How long a transcription takes depends on the audio's length and this
// machine's speed, so the total is generous. What's held tight is silence: a
// run that prints nothing for this long has stalled. The first segment also
// waits on the model being downloaded and loaded.
const TRANSCRIBE_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 hours
const FIRST_SEGMENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const BETWEEN_SEGMENTS_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * The audio file at `audioPath`, transcribed: each segment Whisper heard, in
 * order, timed against the original audio. The language is detected.
 */
export async function transcribeAI(
  model: string,
  audioPath: string,
): Promise<TranscriptSegment[]> {
  return withTimeout(
    {
      timeoutMs: TRANSCRIBE_TIMEOUT_MS,
      firstProgressTimeoutMs: FIRST_SEGMENT_TIMEOUT_MS,
      progressTimeoutMs: BETWEEN_SEGMENTS_TIMEOUT_MS,
    },
    async ({ abortSignal, markProgress }) => {
      const { name, url } = whisperModel(model);
      const [pcm, vadPath, modelPath] = await Promise.all([
        decodeAudio(audioPath, abortSignal),
        modelFile(VAD_MODEL.name, VAD_MODEL.url, abortSignal),
        modelFile(name, url, abortSignal),
        loadWhisper(),
      ]);

      const spans = await detectSpeech(pcm, vadPath);
      abortSignal.throwIfAborted();
      if (spans.length === 0) return [];
      const speech = speechOnly(pcm, spans);

      const whisper = await initWhisper({ filePath: modelPath, useGpu: true });
      try {
        const { stop, promise } = whisper.transcribeData(
          arrayBufferOf(speech.pcm),
          // whisper.cpp assumes English unless told to detect the language.
          { language: "auto", onNewSegments: markProgress },
        );
        const onAbort = () => void stop();
        abortSignal.addEventListener("abort", onAbort, { once: true });
        let result;
        try {
          result = await promise;
        } finally {
          abortSignal.removeEventListener("abort", onAbort);
        }
        abortSignal.throwIfAborted();

        // The binding times segments in milliseconds.
        return result.segments.map(({ t0, t1, text }) => ({
          start: speech.toOriginalMs(t0) / 1000,
          end: speech.toOriginalMs(t1) / 1000,
          text,
        }));
      } finally {
        await whisper.release();
      }
    },
  );
}

/**
 * The Whisper models, smallest and fastest first. Larger ones transcribe
 * better and take longer.
 */
const TRANSCRIBE_MODELS: readonly TranscribeModel[] = [
  { id: "tiny", name: "Whisper Tiny" },
  { id: "base", name: "Whisper Base" },
  { id: "small", name: "Whisper Small" },
  { id: "medium", name: "Whisper Medium" },
  { id: "large-v3-turbo", name: "Whisper Large v3 Turbo" },
  { id: "large-v3", name: "Whisper Large v3" },
];

export async function listTranscribeModels(): Promise<TranscribeModel[]> {
  return [...TRANSCRIBE_MODELS];
}

/** Whether a model id can be used for transcription. */
export async function isValidTranscribeModel(
  modelId: string,
): Promise<boolean> {
  return TRANSCRIBE_MODELS.some((model) => model.id === modelId);
}

/** Fast enough on a CPU for long audio, and accurate enough to summarize. */
export const DEFAULT_TRANSCRIBE_MODEL = "small";
