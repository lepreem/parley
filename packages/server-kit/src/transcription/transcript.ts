import { z } from "zod";

/**
 * A stretch of speech: when it starts and ends, in seconds from the start of
 * the recording, and what was said. Every way a transcript comes about
 * (Deepgram, Whisper, a YouTube caption track) answers with these, so what
 * happens to a transcript next is the same on both servers.
 */
export type TranscriptSegment = { start: number; end: number; text: string };

/** Checks segments that arrive from outside, such as in a queue message. */
export const transcriptSegmentSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string(),
}) satisfies z.ZodType<TranscriptSegment>;

/** A pause at least this long between segments starts a new paragraph. */
const PARAGRAPH_PAUSE_SECONDS = 2;

/**
 * A paragraph this long ends at the next sentence end. A talk can run for
 * minutes without a pause that long, which would otherwise make it one block.
 */
const PARAGRAPH_TARGET_CHARS = 500;

/**
 * A paragraph this long ends at the next segment, sentence end or not.
 * Automatic captions have no punctuation, so without this a whole video would
 * be one paragraph with one timestamp.
 */
const PARAGRAPH_MAX_CHARS = 1_000;

/** Whether text ends a sentence, closing quotes and brackets aside. */
const endsSentence = (text: string) => /[.!?]["')\]]*$/.test(text);

/**
 * Segments joined into paragraphs: where the speaker pauses, or once a
 * paragraph is long enough. Each paragraph runs from its first segment's
 * start to its last one's end. Segments with no text are dropped.
 */
export function paragraphsOf(
  segments: readonly TranscriptSegment[],
): TranscriptSegment[] {
  const paragraphs: TranscriptSegment[] = [];

  for (const segment of segments) {
    const text = segment.text.replace(/\s+/g, " ").trim();
    if (!text) continue;

    const paragraph = paragraphs.at(-1);
    const startsParagraph =
      paragraph === undefined ||
      segment.start - paragraph.end >= PARAGRAPH_PAUSE_SECONDS ||
      (paragraph.text.length >= PARAGRAPH_TARGET_CHARS &&
        endsSentence(paragraph.text)) ||
      paragraph.text.length >= PARAGRAPH_MAX_CHARS;

    if (startsParagraph) {
      paragraphs.push({ start: segment.start, end: segment.end, text });
    } else {
      paragraph.text = `${paragraph.text} ${text}`;
      paragraph.end = Math.max(paragraph.end, segment.end);
    }
  }

  return paragraphs;
}

/** A time in the recording as people write it: 4:05, or 1:02:03 past an hour. */
export function formatTimestamp(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}`
    : `${minutes}:${secs}`;
}

/**
 * The transcript as text, for the model and for people: one paragraph per
 * block, each starting with when it was said, like `[4:05] So the plan is…`.
 * Empty when nothing was said.
 */
export function transcriptText(segments: readonly TranscriptSegment[]) {
  return paragraphsOf(segments)
    .map(
      (paragraph) => `[${formatTimestamp(paragraph.start)}] ${paragraph.text}`,
    )
    .join("\n\n");
}
