import type { DictatedSpeech } from "@parley/contract";
import { apiJson } from "./http";
import type { Server } from "./server";

/** What was said in `recording`; empty if nothing was. */
export async function transcribeRecording(
  server: Server,
  recording: Blob,
  signal: AbortSignal,
): Promise<string> {
  const { text } = await apiJson<DictatedSpeech>(server, "/speech/transcribe", {
    method: "POST",
    body: recording,
    signal,
  });
  return text;
}
