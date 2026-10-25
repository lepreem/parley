import type {
  ChatModel,
  ModelsResponse,
  TranscribeModel,
} from "@parley/contract";
import { chat, transcription } from "../ai";
import { authed } from "../middleware/auth.middleware";

export const handleGetModels = authed.createHandlers(async (c) => {
  return c.json({
    models: await chat.listModels(),
  } satisfies ModelsResponse<ChatModel>);
});

export const handleGetTranscribeModels = authed.createHandlers(async (c) => {
  return c.json({
    models: await transcription.listModels(),
  } satisfies ModelsResponse<TranscribeModel>);
});
