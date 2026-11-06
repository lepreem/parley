import type { Context } from "hono";
import type { ChatModel, ModelsResponse } from "@parley/contract";
import { memory } from "../memory";

export async function handleGetModels(c: Context) {
  return c.json({
    models: await memory.chatCatalog.list(),
  } satisfies ModelsResponse<ChatModel>);
}
