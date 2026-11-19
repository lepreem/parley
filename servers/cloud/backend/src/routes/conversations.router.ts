import { Hono } from "hono";
import * as conversationsController from "../controllers/conversations.controller";
import { conversationRateLimiter } from "../middleware/rateLimit.middleware";
import {
  requireAuth,
  requireFeature,
  type AuthEnv,
} from "../middleware/auth.middleware";
import { messagesRouter } from "./messages.router";

export const conversationsRouter = new Hono<AuthEnv>();

// Mounted above the use() below, so the messages router declares its own auth
// and budgets — which is what keeps a model call off the conversation budget.
conversationsRouter.route("/:conversationId/messages", messagesRouter);

conversationsRouter.use("*", requireAuth, conversationRateLimiter);

conversationsRouter.get(
  "/",
  ...conversationsController.handleListConversations,
);

conversationsRouter.post(
  "/",
  ...conversationsController.handleCreateConversation,
);

conversationsRouter.get(
  "/:conversationId",
  ...conversationsController.handleGetConversation,
);

conversationsRouter.patch(
  "/:conversationId",
  ...conversationsController.handlePatchConversation,
);

conversationsRouter.put(
  "/:conversationId/project",
  requireFeature("projects"),
  ...conversationsController.handleMoveConversation,
);

conversationsRouter.delete(
  "/:conversationId",
  ...conversationsController.handleDeleteConversation,
);
