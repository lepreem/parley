import type { DictatedSpeech } from "@parley/contract";
import { audioClipBody } from "@parley/server-kit/http/audioClip";
import { transcribeDictation } from "../ai";
import { authed } from "../middleware/auth.middleware";

/** POST /speech/transcribe: a dictated message, as text. Nothing is kept. */
export const handleDictation = authed.createHandlers(
  audioClipBody,
  async (c) => {
    const text = await transcribeDictation(
      c.var.audioClip,
      c.req.header("Content-Type") ?? "",
    );
    return c.json({ text } satisfies DictatedSpeech);
  },
);
