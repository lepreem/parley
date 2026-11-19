import type { Conversation, ConversationsResponse } from "@parley/contract";
import { CAPABILITIES } from "@parley/contract/tiers";
import { authed, refusalOf } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import {
  conversationCreateBodySchema,
  conversationMoveBodySchema,
  conversationPatchBodySchema,
  conversationReqParamSchema,
} from "../schema/conversations.schema";
import * as uploads from "../uploads/uploads";
import * as data from "../data";

function toConversationJson(
  row: data.conversations.ConversationRow,
): Conversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    projectId: row.projectId,
  };
}

/** GET /conversations — the user's conversations, most recently active first. */
export const handleListConversations = authed.createHandlers(async (c) => {
  const { userId } = c.var;

  const rows = await data.conversations.findUserConversations(userId);

  return c.json({
    conversations: rows.map(toConversationJson),
  } satisfies ConversationsResponse);
});

/** GET /conversations/:conversationId */
export const handleGetConversation = authed.createHandlers(
  validate("param", conversationReqParamSchema),
  async (c) => {
    const { userId } = c.var;
    const { conversationId } = c.req.valid("param");

    const row = await data.conversations.findOwnedConversation(
      userId,
      conversationId,
    );

    if (!row) return c.json({ message: "Conversation not found" }, 404);
    return c.json(toConversationJson(row));
  },
);

/**
 * POST /conversations — title optional; the DB default applies when omitted.
 * With a project, the chat starts in it.
 */
export const handleCreateConversation = authed.createHandlers(
  validate("json", conversationCreateBodySchema),
  async (c) => {
    const { userId, tier } = c.var;
    const { conversationTitle: title, projectId } = c.req.valid("json");
    if (projectId !== undefined && !CAPABILITIES[tier].projects)
      return c.json({ message: refusalOf(tier, "projects") }, 403);

    const row = await data.conversations.createConversation(userId, {
      ...(title !== undefined ? { title } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
    });

    if (!row) return c.json({ message: "Project not found" }, 404);
    return c.json(toConversationJson(row), 201);
  },
);

/** PUT /conversations/:conversationId/project — into a project, or out of one. */
export const handleMoveConversation = authed.createHandlers(
  validate("param", conversationReqParamSchema),
  validate("json", conversationMoveBodySchema),
  async (c) => {
    const { userId } = c.var;
    const { conversationId } = c.req.valid("param");
    const { projectId } = c.req.valid("json");

    const row = await data.conversations.moveConversation(
      userId,
      conversationId,
      projectId,
    );

    if (!row) return c.json({ message: "Conversation not found" }, 404);
    return c.json(toConversationJson(row));
  },
);

/** PATCH /conversations/:conversationId — rename. */
export const handlePatchConversation = authed.createHandlers(
  validate("param", conversationReqParamSchema),
  validate("json", conversationPatchBodySchema),
  async (c) => {
    const { userId } = c.var;
    const { conversationId } = c.req.valid("param");
    const { conversationTitle: title } = c.req.valid("json");

    const row = await data.conversations.renameConversation(
      userId,
      conversationId,
      title,
    );

    if (!row) return c.json({ message: "Conversation not found" }, 404);
    return c.json(toConversationJson(row));
  },
);

/** DELETE /conversations/:conversationId */
export const handleDeleteConversation = authed.createHandlers(
  validate("param", conversationReqParamSchema),
  async (c) => {
    const { userId } = c.var;
    const { conversationId } = c.req.valid("param");

    // Keep the candidates before their message links cascade away. Uploads still
    // referenced by another conversation are filtered out after the delete.
    const imageUploadIds = await data.images.findConversationImageAttachmentIds(
      userId,
      conversationId,
    );

    const row = await data.conversations.deleteOwnedConversation(
      userId,
      conversationId,
    );

    if (!row) {
      const ownedConversation = await data.conversations.findOwnedConversation(
        userId,
        conversationId,
      );
      if (!ownedConversation)
        return c.json({ message: "Conversation not found" }, 404);
      return c.json({ message: "A response is already in progress" }, 409);
    }

    const deletedImageAttachmentIds =
      await data.images.deleteOwnedUnlinkedUnreservedImageAttachments(
        userId,
        imageUploadIds,
      );
    await uploads.deleteObjects(
      userId,
      deletedImageAttachmentIds.map((uploadId) => ({
        kind: "image",
        uploadId,
      })),
    );
    return c.json({ message: "Conversation deleted" }, 200);
  },
);
