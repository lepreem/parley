import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DictatedSpeech } from "@parley/contract";
import type { Context } from "hono";
import { dictateAI } from "../../../core/ai/ai_transcribe_client";

/**
 * POST /speech/transcribe: a dictated message, as text. ffmpeg reads from a
 * file, so the recording spends the transcription in a temporary one, and
 * nothing is kept.
 */
export async function handleDictation(
  c: Context<{ Variables: { audioClip: Uint8Array<ArrayBuffer> } }>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "parley-dictation-"));
  try {
    const audioPath = path.join(directory, "recording");
    await writeFile(audioPath, c.var.audioClip);
    // The request's signal fires if whoever sent it goes away.
    const text = await dictateAI(audioPath, c.req.raw.signal);
    return c.json({ text } satisfies DictatedSpeech);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
