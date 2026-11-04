import {
  addNativeLogListener,
  initWhisper,
  initWhisperVad,
  loadWhisperModule,
  toggleNativeLog,
} from "@fugood/whisper.node";
import { logger } from "@parley/server-kit/runtime/logger";
import { withTimeout } from "@parley/server-kit/runtime/withTimeout";
import type { TranscriptSegment } from "@parley/server-kit/transcription/transcript";
import { decodeAudio, pingFfmpeg } from "./decodeAudio";
import { type ModelSource, modelFile } from "./modelFiles";
import { type Span, speechOnly } from "./speechOnly";

const log = logger.child({ component: "whisper" });

/**
 * Transcription runs on this machine, with whisper.cpp through
 * @fugood/whisper.node, whose prebuilt binding npm installs for this platform:
 * Metal on Apple Silicon, the CPU elsewhere. ffmpeg decodes the file first,
 * and voice detection cuts out the silences.
 */

/**
 * The Whisper model every file is transcribed with, in whisper.cpp's format:
 * Small, fast enough on a CPU for long audio and accurate enough to
 * summarize. It comes from Hugging Face at a fixed commit, rather than
 * whatever the repo holds today, and is checked against the sha256 Hugging
 * Face lists for it there. Moving to a newer commit, or another model, means
 * taking the new hash from the same place.
 */
const WHISPER_MODEL: ModelSource = {
  name: "ggml-small.bin",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin",
  sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
};

/** Silero, the voice detection model whisper.cpp runs. */
const VAD_MODEL: ModelSource = {
  name: "ggml-silero-v6.2.0.bin",
  url: "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin",
  sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
};

/**
 * Whether Whisper runs on the GPU. Not on an Intel Mac: a transcription sat for
 * half an hour there without finishing a segment, and such a Mac's GPU has little
 * to offer it anyway.
 */
export function whisperUsesGpu(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return !(platform === "darwin" && arch === "x64");
}

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
  audioPath: string,
): Promise<TranscriptSegment[]> {
  return withTimeout(
    {
      timeoutMs: TRANSCRIBE_TIMEOUT_MS,
      firstProgressTimeoutMs: FIRST_SEGMENT_TIMEOUT_MS,
      progressTimeoutMs: BETWEEN_SEGMENTS_TIMEOUT_MS,
    },
    async ({ abortSignal, markProgress }) => {
      const [pcm, vadPath, modelPath] = await Promise.all([
        decodeAudio(audioPath, abortSignal),
        modelFile(VAD_MODEL, abortSignal),
        modelFile(WHISPER_MODEL, abortSignal),
        loadWhisper(),
      ]);

      const spans = await detectSpeech(pcm, vadPath);
      abortSignal.throwIfAborted();
      if (spans.length === 0) return [];
      const speech = speechOnly(pcm, spans);

      const whisper = await initWhisper({
        filePath: modelPath,
        useGpu: whisperUsesGpu(),
      });
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
