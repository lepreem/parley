import type { DictatedSpeech } from "@parley/contract";
import { audioClipBody } from "@parley/server-kit/http/audioClip";
import { transcribeDictation } from "../ai";
import { getEnv } from "../env";
import { authed } from "../middleware/auth.middleware";

/** POST /speech/transcribe: a dictated message, as text. Nothing is kept. */
export const handleDictation = authed.createHandlers(
  audioClipBody,
  async (c) => {
    const { OPENROUTER_DICTATION_API_KEY: apiKey } = getEnv();
    if (!apiKey) return c.json({ message: "Dictation isn't available" }, 404);

    const text = await transcribeDictation(
      apiKey,
      c.var.audioClip,
      c.req.header("Content-Type") ?? "",
    );
    return c.json({ text } satisfies DictatedSpeech);
  },
);
