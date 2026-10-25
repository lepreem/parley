import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import {
  Attachments,
  ChatMessageAttachmentLinks,
  ChatMessages,
  Conversations,
  TranscriptContents,
  db,
  type Executor,
} from "../db";
import { images } from "./images.data";
import { claimIsFreeOrExpired, conversations } from "./conversations.data";
import { messageAttachmentLinks } from "./messageAttachmentLinks.data";
import { attachments } from "./attachments.data";

/**
 * The columns a message is exposed through — every read feeding `toMessageJson`
 * projects exactly these, so `updatedAt` never leaves the table.
 */
const messageColumns = {
  id: ChatMessages.id,
  role: ChatMessages.role,
  content: ChatMessages.content,
  chosenModelId: ChatMessages.chosenModelId,
  stopped: ChatMessages.stopped,
  conversationId: ChatMessages.conversationId,
  createdAt: ChatMessages.createdAt,
};

type MessageCursor = Pick<
  typeof ChatMessages.$inferSelect,
  "id" | "roleOrder" | "createdAt"
>;

/**
 * Messages are ordered by (createdAt, roleOrder, id), so a cursor comparison has to
 * walk that tuple rather than compare one column. `side` picks the direction:
 * `gt` for what follows the cursor, `lt` for what precedes it.
 */
function messageIsOn(side: typeof gt | typeof lt, cursor: MessageCursor) {
  return or(
    side(ChatMessages.createdAt, cursor.createdAt),
    and(
      eq(ChatMessages.createdAt, cursor.createdAt),
      side(ChatMessages.roleOrder, cursor.roleOrder),
    ),
    and(
      eq(ChatMessages.createdAt, cursor.createdAt),
      eq(ChatMessages.roleOrder, cursor.roleOrder),
      side(ChatMessages.id, cursor.id),
    ),
  );
}

const messageIsAfter = (cursor: MessageCursor) => messageIsOn(gt, cursor);
const messageIsBefore = (cursor: MessageCursor) => messageIsOn(lt, cursor);

export type MessageRow = Pick<
  typeof ChatMessages.$inferSelect,
  keyof typeof messageColumns
>;

/** Full history for a conversation, oldest first. */
async function findConversationMessages(conversationId: string) {
  return db
    .select(messageColumns)
    .from(ChatMessages)
    .where(eq(ChatMessages.conversationId, conversationId))
    .orderBy(
      asc(ChatMessages.createdAt),
      asc(ChatMessages.roleOrder),
      asc(ChatMessages.id),
    );
}

/** An image as the model takes it: its file, and what kind of image it is. */
export type HistoryImage = { imageUploadId: string; mimeType: string };

export type CreateMessageHistory = {
  id: string;
  role: MessageRow["role"];
  content: string;
  createdAt: Date;
  transcriptContents: string[];
  images: HistoryImage[];
  contextCharCount: number;
};

type CreateMessageHistoryRow = {
  currentTurnContextCharCount: number;
  currentTranscriptCount: number;
  messageId: string | null;
  role: MessageRow["role"] | null;
  content: string | null;
  /** Epoch milliseconds. */
  createdAt: number | null;
  attachmentId: string | null;
  attachmentKind: "image" | "audio" | null;
  attachmentMimeType: string | null;
  transcriptContent: string | null;
  transcriptCharCount: number | null;
};

/** Fully resolved admitted history for POST message creation, newest first. */
async function findCreateMessageHistory(input: {
  conversationId: string;
  newMessageContentCharCount: number;
  newTranscriptUploadIds: readonly string[];
  transcriptSeparatorCharCount: number;
  maximumContextCharCount: number;
  maximumMessageCount: number;
  maximumImageCount: number;
  /** Editing a message: take history from before it, not from the tail. */
  beforeMessageId?: string;
}): Promise<CreateMessageHistory[]> {
  const currentTranscriptFilter =
    input.newTranscriptUploadIds.length > 0
      ? inArray(TranscriptContents.audioUploadId, [
          ...input.newTranscriptUploadIds,
        ])
      : sql`false`;

  // Same order as messageIsBefore: created_at, then role_order, then id.
  const historyBound =
    input.beforeMessageId === undefined
      ? sql``
      : sql`and (
          ${ChatMessages.createdAt},
          ${ChatMessages.roleOrder},
          ${ChatMessages.id}
        ) < (
          select
            bound.${sql.identifier(ChatMessages.createdAt.name)},
            bound.${sql.identifier(ChatMessages.roleOrder.name)},
            bound.${sql.identifier(ChatMessages.id.name)}
          from ${ChatMessages} as bound
          where bound.${sql.identifier(ChatMessages.id.name)} = ${input.beforeMessageId}
            and bound.${sql.identifier(ChatMessages.conversationId.name)} = ${input.conversationId}
        )`;

  const rows = await db.all<CreateMessageHistoryRow>(sql`
    with current_turn as (
      select
        (
          ${input.newMessageContentCharCount}
          + coalesce(
              sum(
                ${TranscriptContents.charCount}
                + ${input.transcriptSeparatorCharCount}
              ),
              0
            )
        ) as context_char_count,
        count(${TranscriptContents.audioUploadId}) as transcript_count
      from ${TranscriptContents}
      inner join ${Attachments}
        on ${Attachments.attachmentId} = ${TranscriptContents.audioUploadId}
        and ${Attachments.kind} = 'audio'
      where ${currentTranscriptFilter}
    ),
    recent_messages as (
      select
        ${ChatMessages.id} as message_id,
        ${ChatMessages.role} as role,
        ${ChatMessages.roleOrder} as role_order,
        ${ChatMessages.content} as content,
        ${ChatMessages.createdAt} as created_at
      from ${ChatMessages}
      where ${ChatMessages.conversationId} = ${input.conversationId}
        ${historyBound}
      order by
        ${ChatMessages.createdAt} desc,
        ${ChatMessages.roleOrder} desc,
        ${ChatMessages.id} desc
      limit coalesce(
        (
          select max(
            0,
            min(
              ${Conversations.contextWindowMessageCount},
              ${input.maximumMessageCount}
            )
          )
          from ${Conversations}
          where ${Conversations.id} = ${input.conversationId}
        ),
        0
      )
    )
    select
      current_turn.context_char_count as "currentTurnContextCharCount",
      current_turn.transcript_count as "currentTranscriptCount",
      recent_messages.message_id as "messageId",
      recent_messages.role as role,
      recent_messages.content as content,
      recent_messages.created_at as "createdAt",
      ${ChatMessageAttachmentLinks.attachmentId} as "attachmentId",
      ${Attachments.kind} as "attachmentKind",
      ${Attachments.mimeType} as "attachmentMimeType",
      ${TranscriptContents.content} as "transcriptContent",
      ${TranscriptContents.charCount} as "transcriptCharCount"
    from current_turn
    left join recent_messages on true
    left join ${ChatMessageAttachmentLinks}
      on ${ChatMessageAttachmentLinks.messageId} = recent_messages.message_id
    left join ${Attachments}
      on ${Attachments.attachmentId} = ${ChatMessageAttachmentLinks.attachmentId}
    left join ${TranscriptContents}
      on ${TranscriptContents.audioUploadId} = ${Attachments.attachmentId}
      and ${Attachments.kind} = 'audio'
    order by
      recent_messages.created_at desc,
      recent_messages.role_order desc,
      recent_messages.message_id desc,
      ${ChatMessageAttachmentLinks.position} asc
  `);
  const currentTurn = rows[0];
  if (
    !currentTurn ||
    currentTurn.currentTranscriptCount !==
      input.newTranscriptUploadIds.length ||
    currentTurn.currentTurnContextCharCount >= input.maximumContextCharCount
  ) {
    return [];
  }

  const candidates: CreateMessageHistory[] = [];
  const historyByMessageId = new Map<string, CreateMessageHistory>();

  for (const row of rows) {
    if (
      row.messageId === null ||
      row.role === null ||
      row.content === null ||
      row.createdAt === null
    ) {
      continue;
    }

    let message = historyByMessageId.get(row.messageId);
    if (!message) {
      message = {
        id: row.messageId,
        role: row.role,
        content: row.content,
        createdAt: new Date(row.createdAt),
        transcriptContents: [],
        images: [],
        contextCharCount: row.content.length,
      };
      candidates.push(message);
      historyByMessageId.set(row.messageId, message);
    }

    if (row.attachmentKind === "audio" && row.transcriptContent !== null) {
      message.transcriptContents.push(row.transcriptContent);
      message.contextCharCount +=
        (row.transcriptCharCount ?? row.transcriptContent.length) +
        input.transcriptSeparatorCharCount;
    }

    if (row.attachmentKind === "image" && row.attachmentId !== null) {
      message.images.push({
        imageUploadId: row.attachmentId,
        mimeType: row.attachmentMimeType ?? "application/octet-stream",
      });
    }
  }

  const history: CreateMessageHistory[] = [];
  let remainingContextCharCount =
    input.maximumContextCharCount - currentTurn.currentTurnContextCharCount;
  for (const message of candidates) {
    if (message.contextCharCount > remainingContextCharCount) break;
    remainingContextCharCount -= message.contextCharCount;
    history.push(message);
  }

  let remainingImageCount = Math.max(0, input.maximumImageCount);
  for (const message of history) {
    message.images = message.images.slice(0, remainingImageCount);
    remainingImageCount -= message.images.length;
  }

  return history;
}

async function createMessage(
  message: {
    role: "user" | "assistant";
    content: string;
    conversationId: string;
    chosenModelId?: string;
    stopped?: boolean;
  },
  executor: Executor = db,
) {
  const [row] = await executor
    .insert(ChatMessages)
    .values(message)
    .returning(messageColumns);

  return row;
}

/**
 * Deletes a message and everything after it, moving the conversation head
 * back. A claimed turn blocks it, unless its lease has run out or the claim
 * is the caller's own (`claimToken`) — editing a message rewinds under the
 * claim it already holds.
 * `onlyRole` refuses a message of any other role, before anything is deleted.
 *
 * Scoped by conversation, so a message id from another conversation doesn't
 * delete through this route. Null when nothing matched, which the caller
 * reports as a 404.
 */
async function deleteMessage(
  conversationId: string,
  messageId: string,
  options: { claimToken?: string; onlyRole?: MessageRow["role"] } = {},
) {
  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .select({
        activeTurnClaimToken: Conversations.activeTurnClaimToken,
        claimIsFree: sql`${claimIsFreeOrExpired()}`.mapWith(Boolean),
      })
      .from(Conversations)
      .where(eq(Conversations.id, conversationId))
      .limit(1);

    if (!conversation) return null;
    if (
      !conversation.claimIsFree &&
      conversation.activeTurnClaimToken !== options.claimToken
    )
      return { status: "active" } as const;

    const [targetMessage] = await tx
      .select({
        id: ChatMessages.id,
        role: ChatMessages.role,
        roleOrder: ChatMessages.roleOrder,
        createdAt: ChatMessages.createdAt,
      })
      .from(ChatMessages)
      .where(
        and(
          eq(ChatMessages.id, messageId),
          eq(ChatMessages.conversationId, conversationId),
        ),
      )
      .limit(1);

    if (!targetMessage) return null;
    if (options.onlyRole && targetMessage.role !== options.onlyRole)
      return { status: "wrong_role" } as const;

    const [newHead] = await tx
      .select({ id: ChatMessages.id })
      .from(ChatMessages)
      .where(
        and(
          eq(ChatMessages.conversationId, conversationId),
          messageIsBefore(targetMessage),
        ),
      )
      .orderBy(
        desc(ChatMessages.createdAt),
        desc(ChatMessages.roleOrder),
        desc(ChatMessages.id),
      )
      .limit(1);

    const deleteFilter = and(
      eq(ChatMessages.conversationId, conversationId),
      or(eq(ChatMessages.id, targetMessage.id), messageIsAfter(targetMessage)),
    );
    const imageRows = await tx
      .select({ imageUploadId: Attachments.attachmentId })
      .from(ChatMessageAttachmentLinks)
      .innerJoin(
        Attachments,
        eq(Attachments.attachmentId, ChatMessageAttachmentLinks.attachmentId),
      )
      .innerJoin(
        ChatMessages,
        eq(ChatMessageAttachmentLinks.messageId, ChatMessages.id),
      )
      .where(and(eq(Attachments.kind, "image"), deleteFilter));

    const deletedMessages = await tx
      .delete(ChatMessages)
      .where(deleteFilter)
      .returning({ id: ChatMessages.id });

    const deletedImageUploadIds =
      await images.deleteUnlinkedUnreservedImageAttachments(
        imageRows.map((image) => image.imageUploadId),
        tx,
      );

    await tx
      .update(Conversations)
      .set({ lastMessageId: newHead?.id ?? null, updatedAt: new Date() })
      .where(eq(Conversations.id, conversationId));

    return {
      status: "deleted",
      ids: deletedMessages.map((message) => message.id),
      imageUploadIds: deletedImageUploadIds,
      lastMessageId: newHead?.id ?? null,
    } as const;
  });
}

/**
 * Persists a completed turn as one transaction: the user message, its
 * attachments, the assistant reply, and the conversation's new head.
 * All-or-nothing, so a mid-write failure can't leave a turn half-recorded — a
 * user message with no reply, or a reply the conversation never points at.
 *
 * It also unclaims the turn: the conversation's claim and the attachments'
 * reservations go in the same transaction. Releasing the claim with the new
 * head means a crash after the commit can't leave the conversation locked
 * until the lease runs out, and the claim check refuses the write if this
 * turn's lease was lost to another.
 */
async function persistAndUnclaimChatTurn(turn: {
  conversationId: string;
  content: string;
  attachmentIds: readonly string[];
  chosenModelId: string;
  assistantContent: string;
  /** The reply was stopped partway, so `assistantContent` is what came. */
  stopped?: boolean;
  conversationTitle?: string;
  contextWindowMessageCount: number;
  claimToken: string;
}) {
  return db.transaction(async (tx) => {
    const userMessage = await createMessage(
      {
        role: "user",
        content: turn.content,
        conversationId: turn.conversationId,
      },
      tx,
    );
    const [assistantMessage] = await Promise.all([
      createMessage(
        {
          role: "assistant",
          content: turn.assistantContent,
          chosenModelId: turn.chosenModelId,
          stopped: turn.stopped ?? false,
          conversationId: turn.conversationId,
        },
        tx,
      ),
      messageAttachmentLinks.linkAttachmentsToMessage(
        userMessage.id,
        turn.attachmentIds,
        tx,
      ),
    ]);
    const completed = await conversations.completeConversationTurn(
      turn.conversationId,
      turn.claimToken,
      assistantMessage.id,
      turn.conversationTitle,
      turn.contextWindowMessageCount,
      tx,
    );
    if (!completed) throw new Error("Conversation turn claim was lost");

    await attachments.unclaimAttachments(turn.claimToken, tx);

    return assistantMessage.id;
  });
}

export const messages = {
  findConversationMessages,
  findCreateMessageHistory,
  deleteMessage,
  persistAndUnclaimChatTurn,
};
