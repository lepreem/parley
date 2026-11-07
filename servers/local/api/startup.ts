import { verifyServices } from "@parley/server-kit/runtime/preflight";
import { memory } from "./src/memory";
import { pingTranscribeAI } from "../core/ai/ai_transcribe_client";
import { ytDlp } from "./src/ytDlp";

/**
 * Fail-fast preflight: aborts startup if any third-party dependency is
 * unavailable.
 */
export function verifyApiServices(): Promise<void> {
  return verifyServices([
    // Claude Code, Codex or both; it fails only when neither can chat.
    { name: "Chat", check: async () => void (await memory.chatCatalog.load()) },
    { name: "Whisper", check: pingTranscribeAI },
    { name: "yt-dlp", check: ytDlp.ping },
  ]);
}
