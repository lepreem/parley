import type { Context } from "hono";
import type { Conversation, ConversationsResponse } from "@parley/contract";
import { CTX_KEYS } from "../../../core/keys";
import { files } from "../../../core/files";
import { data, type ConversationRow } from "../../../core/data";

function toConversationJson(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** GET /conversations — every conversation, most recently active first. */
export async function handleListConversations(c: Context) {
  const rows = await data.conversations.findConversations();

  return c.json({
    conversations: rows.map(toConversationJson),
  } satisfies ConversationsResponse);
}

/** GET /conversations/:conversationId */
export async function handleGetConversation(c: Context) {
  const conversationId = c.get(CTX_KEYS.conversationId);

  const row = await data.conversations.findConversation(conversationId);

  if (!row) return c.json({ message: "Conversation not found" }, 404);
  return c.json(toConversationJson(row));
}

/** POST /conversations — title optional; the DB default applies when omitted. */
export async function handleCreateConversation(c: Context) {
  const title: string | undefined = c.get(CTX_KEYS.conversationTitle);

  const row = await data.conversations.createConversation(title);

  return c.json(toConversationJson(row), 201);
}

/** PATCH /conversations/:conversationId — rename. */
export async function handlePatchConversation(c: Context) {
  const conversationId = c.get(CTX_KEYS.conversationId);
  const title: string = c.get(CTX_KEYS.conversationTitle);

  const row = await data.conversations.renameConversation(
    conversationId,
    title,
  );

  if (!row) return c.json({ message: "Conversation not found" }, 404);
  return c.json(toConversationJson(row));
}

/** DELETE /conversations/:conversationId */
export async function handleDeleteConversation(c: Context) {
  const conversationId = c.get(CTX_KEYS.conversationId);

  // Keep the candidates before their message links cascade away. Uploads still
  // referenced by another conversation are filtered out after the delete.
  const imageUploadIds =
    await data.images.findConversationImageAttachmentIds(conversationId);

  const row = await data.conversations.deleteConversation(conversationId);

  if (!row) {
    const conversation =
      await data.conversations.findConversation(conversationId);
    if (!conversation)
      return c.json({ message: "Conversation not found" }, 404);
    return c.json({ message: "A response is already in progress" }, 409);
  }

  const deletedImageAttachmentIds =
    await data.images.deleteUnlinkedUnreservedImageAttachments(imageUploadIds);
  await files.delete(
    deletedImageAttachmentIds.map((uploadId) => ({ kind: "image", uploadId })),
  );
  return c.json({ message: "Conversation deleted" }, 200);
}
