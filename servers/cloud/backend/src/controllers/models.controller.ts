import type { ChatModelsResponse } from "@parley/contract";
import { chat } from "../ai";
import { authed } from "../middleware/auth.middleware";

/** Each tier is offered only the models its turns may use. */
export const handleGetModels = authed.createHandlers(async (c) => {
  return c.json({
    models: await chat.listModelsFor(c.var.tier),
    defaultModelId: chat.defaultModelId,
    recommendedModelIds: chat.recommendedModelIds,
  } satisfies ChatModelsResponse);
});
