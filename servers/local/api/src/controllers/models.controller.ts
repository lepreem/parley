import type { Context } from "hono";
import type { ChatModelsResponse } from "@parley/contract";
import { memory } from "../memory";

export async function handleGetModels(c: Context) {
  return c.json({
    models: await memory.chatCatalog.list(),
    defaultModelId: await memory.chatCatalog.defaultModel(),
    // The programs' own lists are short already.
    recommendedModelIds: [],
  } satisfies ChatModelsResponse);
}
