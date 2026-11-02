import { SAMPLE_RATE } from "./decodeAudio";

/** A stretch of the audio, in milliseconds from its start. */
export type Span = { startMs: number; endMs: number };

/** Bytes in one sample of 16-bit PCM. */
const BYTES_PER_SAMPLE = 2;

/**
 * Silence put between two stretches of speech, so the words either side of a
 * cut don't run together.
 */
const GAP_MS = 100;

const bytesAt = (ms: number) =>
  Math.round((ms * SAMPLE_RATE) / 1000) * BYTES_PER_SAMPLE;

/**
 * Only the speech in `pcm`: the `spans` voice detection found, back to back
 * with a short silence between. Whisper tends to invent text in long silences,
 * and skipping them is faster too. faster-whisper's `vad_filter` and
 * whisper.cpp's own `--vad` do the same.
 *
 * `toOriginalMs` takes a time in the shortened audio back to the same moment
 * in the original; a time inside a gap is the end of the speech before it.
 */
export function speechOnly(
  pcm: Buffer,
  spans: readonly Span[],
): { pcm: Buffer; toOriginalMs: (ms: number) => number } {
  // Padded spans can overlap; they're joined so no audio plays twice.
  const merged: Span[] = [];
  for (const span of [...spans].sort((a, b) => a.startMs - b.startMs)) {
    const last = merged.at(-1);
    if (last && span.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, span.endMs);
    } else {
      merged.push({ ...span });
    }
  }

  const gap = Buffer.alloc(bytesAt(GAP_MS));
  const parts: Buffer[] = [];
  const pieces: {
    startMs: number;
    originalStartMs: number;
    durationMs: number;
  }[] = [];
  let lengthMs = 0;
  for (const span of merged) {
    if (parts.length > 0) {
      parts.push(gap);
      lengthMs += GAP_MS;
    }
    const part = pcm.subarray(bytesAt(span.startMs), bytesAt(span.endMs));
    const durationMs = (part.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;
    parts.push(part);
    pieces.push({
      startMs: lengthMs,
      originalStartMs: span.startMs,
      durationMs,
    });
    lengthMs += durationMs;
  }

  return {
    pcm: Buffer.concat(parts),
    toOriginalMs: (ms) => {
      const piece =
        pieces.findLast((candidate) => candidate.startMs <= ms) ?? pieces[0];
      if (!piece) return ms;
      return (
        piece.originalStartMs +
        Math.min(Math.max(ms - piece.startMs, 0), piece.durationMs)
      );
    },
  };
}
