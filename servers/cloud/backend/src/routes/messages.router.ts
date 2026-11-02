import { Hono } from "hono";
import * as messagesController from "../controllers/messages.controller";
import {
  chatTurnRateLimiter,
  conversationRateLimiter,
  guestChatTurnRateLimiter,
} from "../middleware/rateLimit.middleware";
import { requireAuth, type AuthEnv } from "../middleware/auth.middleware";
import { httpCache } from "@parley/server-kit/http/cache.middleware";

/**
 * Mounted under /conversations/:conversationId/messages, ahead of the parent's
 * middleware, so nothing here is reached by it: auth and every budget are
 * declared below. Reading and deleting spend the conversation budget; sending
 * and editing ask the model, so they spend the chat-turn one instead.
 */
export const messagesRouter = new Hono<AuthEnv>();

messagesRouter.use("*", requireAuth);

messagesRouter.get(
  "/",
  conversationRateLimiter,
  httpCache({ revalidate: true }),
  ...messagesController.handleListMessages,
);

messagesRouter.delete(
  "/:messageId",
  conversationRateLimiter,
  ...messagesController.handleDeleteMessage,
);

messagesRouter.post(
  "/",
  chatTurnRateLimiter,
  guestChatTurnRateLimiter,
  ...messagesController.handleCreateMessage,
);

messagesRouter.post(
  "/stop",
  conversationRateLimiter,
  ...messagesController.handleStopReply,
);

messagesRouter.patch(
  "/:messageId",
  chatTurnRateLimiter,
  guestChatTurnRateLimiter,
  ...messagesController.handlePatchMessage,
);
