import { Hono } from "hono";
import * as conversationsController from "../controllers/conversations.controller";
import {
  validateReqParams,
  validateReqBody,
} from "../middleware/validate.middleware";
import { CTX_KEYS } from "../../../core/keys";
import {
  conversationReqParamSchema,
  conversationCreateBodySchema,
  conversationPatchBodySchema,
} from "../schema/conversations.schema";
import { messagesRouter } from "./messages.router";

export const conversationsRouter = new Hono();

conversationsRouter.get("/", conversationsController.handleListConversations);

conversationsRouter.post(
  "/",
  validateReqBody(conversationCreateBodySchema),
  conversationsController.handleCreateConversation,
);

conversationsRouter.get(
  `/:${CTX_KEYS.conversationId}`,
  validateReqParams(conversationReqParamSchema),
  conversationsController.handleGetConversation,
);

conversationsRouter.patch(
  `/:${CTX_KEYS.conversationId}`,
  validateReqParams(conversationReqParamSchema),
  validateReqBody(conversationPatchBodySchema),
  conversationsController.handlePatchConversation,
);

conversationsRouter.delete(
  `/:${CTX_KEYS.conversationId}`,
  validateReqParams(conversationReqParamSchema),
  conversationsController.handleDeleteConversation,
);

conversationsRouter.route(
  `/:${CTX_KEYS.conversationId}/messages`,
  messagesRouter,
);
