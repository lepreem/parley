import { verifyServices } from "@parley/server-kit/runtime/preflight";
import { pingChatAI } from "../core/ai/ai_chat_client";
import { pingTranscribeAI } from "../core/ai/ai_transcribe_client";
import { ytDlp } from "./src/ytDlp";

/**
 * Fail-fast preflight: aborts startup if any third-party dependency is
 * unavailable.
 */
export function verifyApiServices(): Promise<void> {
  return verifyServices([
    { name: "Claude Code", check: pingChatAI },
    { name: "Whisper", check: pingTranscribeAI },
    { name: "yt-dlp", check: ytDlp.ping },
  ]);
}
