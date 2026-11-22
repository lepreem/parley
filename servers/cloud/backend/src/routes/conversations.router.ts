import { Hono } from "hono";
import * as conversationsController from "../controllers/conversations.controller";
import { conversationRateLimiter } from "../middleware/rateLimit.middleware";
import {
  requireAuth,
  requireFeature,
  type AuthEnv,
} from "../middleware/auth.middleware";
import { messagesRouter } from "./messages.router";
import { agentTool } from "../agentTools";

export const conversationsRouter = new Hono<AuthEnv>();

// Mounted above the use() below, so the messages router declares its own auth
// and budgets — which is what keeps a model call off the conversation budget.
conversationsRouter.route("/:conversationId/messages", messagesRouter);

conversationsRouter.use("*", requireAuth, conversationRateLimiter);

conversationsRouter.get(
  "/",
  ...agentTool(
    {
      name: "list_chats",
      description:
        "List the user's chats, most recently active first, with each one's id, title and project id (null when it's in no project).",
      effect: "read",
    },
    conversationsController.handleListConversations,
  ),
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
  ...agentTool(
    {
      name: "rename_chat",
      description:
        "Rename one of the user's chats. Use list_chats to find a chat's id, unless it's this chat.",
      effect: "change",
    },
    conversationsController.handlePatchConversation,
  ),
);

conversationsRouter.put(
  "/:conversationId/project",
  requireFeature("projects"),
  ...agentTool(
    {
      name: "move_chat_to_project",
      description:
        "Move one of the user's chats into a project, or out of its project with a projectId of null. Use list_projects for a project's id.",
      effect: "change",
      feature: "projects",
    },
    conversationsController.handleMoveConversation,
  ),
);

conversationsRouter.delete(
  "/:conversationId",
  ...conversationsController.handleDeleteConversation,
);
