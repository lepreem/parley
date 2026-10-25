import type { Context } from "hono";
import type {
  ChatModel,
  ModelsResponse,
  TranscribeModel,
} from "@parley/contract";
import { listChatModels } from "../../../core/ai/ai_chat_client";
import { listTranscribeModels } from "../../../core/ai/ai_transcribe_client";

export async function handleGetModels(c: Context) {
  return c.json({
    models: await listChatModels(),
  } satisfies ModelsResponse<ChatModel>);
}

export async function handleGetTranscribeModels(c: Context) {
  return c.json({
    models: await listTranscribeModels(),
  } satisfies ModelsResponse<TranscribeModel>);
}
