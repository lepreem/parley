import type {
  ChatModel,
  ModelsResponse,
  TranscribeModel,
} from "@parley/contract";
import { chat, transcription } from "../ai";
import { authed } from "../middleware/auth.middleware";

/** A guest is offered only the models a guest turn may use. */
export const handleGetModels = authed.createHandlers(async (c) => {
  return c.json({
    models: c.var.isGuest
      ? await chat.listGuestModels()
      : await chat.listModels(),
  } satisfies ModelsResponse<ChatModel>);
});

export const handleGetTranscribeModels = authed.createHandlers(async (c) => {
  return c.json({
    models: await transcription.listModels(),
  } satisfies ModelsResponse<TranscribeModel>);
});
