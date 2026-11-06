import type { Context } from "hono";
import type { ChatModel, ModelsResponse } from "@parley/contract";
import { listChatModels } from "../../../core/ai/ai_chat_client";

export async function handleGetModels(c: Context) {
  return c.json({
    models: await listChatModels(),
  } satisfies ModelsResponse<ChatModel>);
}
