/**
 * Speech-to-text: a file's from Deepgram, a dictated message's from Whisper
 * on OpenRouter. `transcription.<what>`.
 *
 * The files beside this one don't import each other; anything that needs two
 * of them is put together here.
 */

import * as memory from "../../memory";
import * as deepgram from "./deepgram";
import {
  currentModel,
  newestVersions,
  type TranscribeModelData,
} from "./model_catalog";

export { ping, transcribe, type Transcription } from "./deepgram";
export { transcribeDictation } from "./dictation";

/** Exported for tests that seed the catalog; callers use model(). */
export function getTranscribeModelData(): Promise<TranscribeModelData> {
  // Served stale while it refreshes, like the chat catalog, so no request
  // waits on Deepgram once a process has loaded it.
  return memory.modelLists.getOrSet(
    memory.modelLists.CACHE_KEYS.deepgramTranscribeModels,
    async () => newestVersions(await deepgram.listModels()),
    { serveStale: true },
  );
}

/**
 * The model a file is transcribed with: Deepgram's current general model.
 * Undefined only while Deepgram's catalog has none.
 */
export async function model(): Promise<string | undefined> {
  return currentModel(await getTranscribeModelData());
}
