import type { ChatModelsResponse } from "@parley/contract";
import { chat } from "../ai";
import { authed } from "../middleware/auth.middleware";

/** A guest is offered only the models a guest turn may use. */
export const handleGetModels = authed.createHandlers(async (c) => {
  return c.json({
    models: c.var.isGuest
      ? await chat.listGuestModels()
      : await chat.listModels(),
    defaultModelId: chat.defaultModelId,
    recommendedModelIds: chat.recommendedModelIds,
  } satisfies ChatModelsResponse);
});
