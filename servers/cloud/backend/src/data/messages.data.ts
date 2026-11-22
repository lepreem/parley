import type { MessageSource } from "@parley/contract";
import type { StoredSource } from "@parley/server-kit/webSources";
import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import {
  Attachments,
  ChatMessageAttachmentLinks,
  ChatMessages,
  Conversations,
  TranscriptContents,
  db,
  type Executor,
} from "../db";
import * as images from "./images.data";
import * as conversations from "./conversations.data";
import * as messageAttachmentLinks from "./messageAttachmentLinks.data";
import * as attachments from "./attachments.data";

/**
 * A reply's sources without the text of the pages it read, which can run to
 * hundreds of thousands of characters and is only ever for the model.
 */
const sourcesWithoutPageText = sql<MessageSource[]>`coalesce(
  (
    select jsonb_agg(source - 'content' order by position)
    from jsonb_array_elements(${ChatMessages.sources})
      with ordinality as page(source, position)
  ),
  '[]'::jsonb
)`;

/**
 * The columns a message is exposed through — every read feeding `toMessageJson`
 * projects exactly these, so `userId` and `updatedAt` never leave the table,
 * and nor does the text of the pages a reply read.
 */
const messageColumns = {
  id: ChatMessages.id,
  role: ChatMessages.role,
  content: ChatMessages.content,
  chosenModelId: ChatMessages.chosenModelId,
  stopped: ChatMessages.stopped,
  sources: sourcesWithoutPageText.as("sources"),
  conversationId: ChatMessages.conversationId,
  createdAt: ChatMessages.createdAt,
};

type MessageCursor = Pick<
  typeof ChatMessages.$inferSelect,
  "id" | "role" | "createdAt"
>;

/**
 * Messages are ordered by (createdAt, role, id), so a cursor comparison has to
 * walk that tuple rather than compare one column. `side` picks the direction:
 * `gt` for what follows the cursor, `lt` for what precedes it.
 */
function messageIsOn(side: typeof gt | typeof lt, cursor: MessageCursor) {
  return or(
    side(ChatMessages.createdAt, cursor.createdAt),
    and(
      eq(ChatMessages.createdAt, cursor.createdAt),
      side(ChatMessages.role, cursor.role),
    ),
    and(
      eq(ChatMessages.createdAt, cursor.createdAt),
      eq(ChatMessages.role, cursor.role),
      side(ChatMessages.id, cursor.id),
    ),
  );
}

const messageIsAfter = (cursor: MessageCursor) => messageIsOn(gt, cursor);
const messageIsBefore = (cursor: MessageCursor) => messageIsOn(lt, cursor);

export type MessageRow = Pick<
  typeof ChatMessages.$inferSelect,
  Exclude<keyof typeof messageColumns, "sources">
> & { sources: MessageSource[] };

/** Full history for a conversation, oldest first. */
export async function findConversationMessages(conversationId: string) {
  return db
    .select(messageColumns)
    .from(ChatMessages)
    .where(eq(ChatMessages.conversationId, conversationId))
    .orderBy(
      asc(ChatMessages.createdAt),
      asc(ChatMessages.role),
      asc(ChatMessages.id),
    );
}

/** A transcript attached to a past turn, by the audio it was made from. */
export type HistoryTranscript = { audioUploadId: string; content: string };

/** A page the model read for a past reply, with the text it read. */
export type HistoryPage = { url: string; title: string; content: string };

/**
 * How far back, in messages, the history read brings the pages replies read.
 * The prompt only has room for a few pages, after the turns themselves, and a
 * page can be tens of thousands of characters, so older ones aren't read.
 */
const PAGE_HISTORY_MESSAGES = 6;

/**
 * A past turn that may go back into the prompt, with what it was sent with:
 * its transcripts in link order, and its images as stored, so the caller
 * signs only the ones it keeps.
 */
export type HistoryCandidate = {
  id: string;
  role: MessageRow["role"];
  content: string;
  createdAt: Date;
  transcripts: HistoryTranscript[];
  /** For a recent reply: the pages it read, in the order it read them. */
  pages: HistoryPage[];
  images: {
    imageUploadId: string;
    signedUrl: string | null;
    signedUrlExpiresAt: Date | null;
  }[];
};

/**
 * Text the caller already holds: message content by message id, transcript
 * content by audio upload id. Both are written once and never changed, so a
 * copy can't disagree with the table.
 */
export type KnownHistoryText = {
  messages: ReadonlyMap<string, string>;
  transcripts: ReadonlyMap<string, string>;
};

type HistoryRow = {
  messageId: string;
  role: MessageRow["role"];
  /** Null when the caller knows it, and on every row of a message but one. */
  content: string | null;
  createdAt: string;
  attachmentId: string | null;
  attachmentKind: "image" | "audio" | null;
  signedUrl: string | null;
  signedUrlExpiresAt: string | null;
  transcriptAudioUploadId: string | null;
  /** Null when the caller knows it. */
  transcriptContent: string | null;
  /** Null for a user message, an older reply, or a reply that read none. */
  pages: HistoryPage[] | null;
};

/** A Postgres array literal, sent as one parameter whatever its length. */
function arrayLiteral(values: Iterable<string>) {
  const quoted = Array.from(
    values,
    (value) => `"${value.replace(/[\\"]/g, "\\$&")}"`,
  );
  return `{${quoted.join(",")}}`;
}

function knownOrThrow(
  known: ReadonlyMap<string, string> | undefined,
  id: string,
) {
  const text = known?.get(id);
  if (text === undefined) throw new Error(`History text missing for ${id}`);
  return text;
}

/**
 * The turns a new message's prompt may draw on, newest first, in one query:
 * at most `maximumMessageCount`, and no more than the conversation's window
 * held last time. Deciding which of them fit is the caller's.
 *
 * The query still decides which turns, attachments and images there are; the
 * text it leaves out is only what `knownText` already holds, and a message's
 * content crosses the wire once however many attachments it has. Sending the
 * text is most of what this read costs.
 */
export async function findContextHistory(input: {
  userId: string;
  conversationId: string;
  maximumMessageCount: number;
  /** Editing a message: take history from before it, not from the tail. */
  beforeMessageId?: string;
  knownText?: KnownHistoryText;
}): Promise<HistoryCandidate[]> {
  // Same order as messageIsBefore: created_at, then role, then id.
  const historyBound =
    input.beforeMessageId === undefined
      ? sql``
      : sql`and (
          ${ChatMessages.createdAt},
          ${ChatMessages.role},
          ${ChatMessages.id}
        ) < (
          select
            bound.${sql.identifier(ChatMessages.createdAt.name)},
            bound.${sql.identifier(ChatMessages.role.name)},
            bound.${sql.identifier(ChatMessages.id.name)}
          from ${ChatMessages} as bound
          where bound.${sql.identifier(ChatMessages.id.name)} = ${input.beforeMessageId}
            and bound.${sql.identifier(ChatMessages.conversationId.name)} = ${input.conversationId}
        )`;
  const knownMessageIds = arrayLiteral(input.knownText?.messages.keys() ?? []);
  const knownAudioUploadIds = arrayLiteral(
    input.knownText?.transcripts.keys() ?? [],
  );

  const rows = await db.execute<HistoryRow>(sql`
    with recent_messages as (
      select
        ${ChatMessages.id} as message_id,
        ${ChatMessages.role} as role,
        case
          when ${ChatMessages.id} = any(${knownMessageIds}::uuid[]) then null
          else ${ChatMessages.content}
        end as content,
        case
          when ${ChatMessages.role} = 'assistant'
            and row_number() over (
              order by
                ${ChatMessages.createdAt} desc,
                ${ChatMessages.role} desc,
                ${ChatMessages.id} desc
            ) <= ${PAGE_HISTORY_MESSAGES}
          then (
            select jsonb_agg(source order by position)
            from jsonb_array_elements(${ChatMessages.sources})
              with ordinality as page(source, position)
            where source->>'content' is not null
          )
        end as pages,
        ${ChatMessages.createdAt} as created_at
      from ${ChatMessages}
      where ${ChatMessages.conversationId} = ${input.conversationId}
        ${historyBound}
      order by
        ${ChatMessages.createdAt} desc,
        ${ChatMessages.role} desc,
        ${ChatMessages.id} desc
      limit coalesce(
        (
          select greatest(
            0,
            least(
              ${Conversations.contextWindowMessageCount},
              ${input.maximumMessageCount}
            )
          )
          from ${Conversations}
          where ${Conversations.id} = ${input.conversationId}
            and ${Conversations.userId} = ${input.userId}
        ),
        0
      )
    )
    select
      recent_messages.message_id as "messageId",
      recent_messages.role as role,
      case
        when row_number() over (
          partition by recent_messages.message_id
          order by ${ChatMessageAttachmentLinks.position}
        ) = 1 then recent_messages.content
      end as content,
      recent_messages.pages as pages,
      recent_messages.created_at as "createdAt",
      ${ChatMessageAttachmentLinks.attachmentId} as "attachmentId",
      ${Attachments.kind} as "attachmentKind",
      ${Attachments.signedUrl} as "signedUrl",
      ${Attachments.signedUrlExpiresAt} as "signedUrlExpiresAt",
      ${TranscriptContents.audioUploadId} as "transcriptAudioUploadId",
      case
        when ${TranscriptContents.audioUploadId} = any(${knownAudioUploadIds}::text[]) then null
        else ${TranscriptContents.content}
      end as "transcriptContent"
    from recent_messages
    left join ${ChatMessageAttachmentLinks}
      on ${ChatMessageAttachmentLinks.messageId} = recent_messages.message_id
    left join ${Attachments}
      on ${Attachments.attachmentId} = ${ChatMessageAttachmentLinks.attachmentId}
      and ${Attachments.userId} = ${input.userId}
    left join ${TranscriptContents}
      on ${TranscriptContents.audioUploadId} = ${Attachments.attachmentId}
      and ${Attachments.kind} = 'audio'
    order by
      recent_messages.created_at desc,
      recent_messages.role desc,
      recent_messages.message_id desc,
      ${ChatMessageAttachmentLinks.position} asc
  `);

  const history: HistoryCandidate[] = [];
  const contentByMessageId = new Map<string, string>();
  const historyByMessageId = new Map<string, HistoryCandidate>();

  for (const row of rows) {
    if (row.content !== null)
      contentByMessageId.set(row.messageId, row.content);

    let message = historyByMessageId.get(row.messageId);
    if (!message) {
      message = {
        id: row.messageId,
        role: row.role,
        content: "",
        createdAt: new Date(row.createdAt),
        transcripts: [],
        pages: row.pages ?? [],
        images: [],
      };
      history.push(message);
      historyByMessageId.set(row.messageId, message);
    }

    if (
      row.attachmentKind === "audio" &&
      row.transcriptAudioUploadId !== null
    ) {
      message.transcripts.push({
        audioUploadId: row.transcriptAudioUploadId,
        content:
          row.transcriptContent ??
          knownOrThrow(
            input.knownText?.transcripts,
            row.transcriptAudioUploadId,
          ),
      });
    }

    if (row.attachmentKind === "image" && row.attachmentId !== null) {
      message.images.push({
        imageUploadId: row.attachmentId,
        signedUrl: row.signedUrl,
        signedUrlExpiresAt: row.signedUrlExpiresAt
          ? new Date(row.signedUrlExpiresAt)
          : null,
      });
    }
  }

  for (const message of history) {
    message.content =
      contentByMessageId.get(message.id) ??
      knownOrThrow(input.knownText?.messages, message.id);
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
    sources?: StoredSource[];
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
 * back. A claimed turn blocks it, unless the claim is the caller's own
 * (`claimToken`) — editing a message rewinds under the claim it already holds.
 * `onlyRole` refuses a message of any other role, before anything is deleted.
 * Scoped by conversation as well as owner; null when nothing matched, which
 * the caller reports as a 404.
 */
export async function deleteOwnedMessage(
  userId: string,
  conversationId: string,
  messageId: string,
  options: { claimToken?: string; onlyRole?: MessageRow["role"] } = {},
) {
  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .select({
        activeTurnClaimToken: Conversations.activeTurnClaimToken,
      })
      .from(Conversations)
      .where(
        and(
          eq(Conversations.id, conversationId),
          eq(Conversations.userId, userId),
        ),
      )
      .limit(1)
      .for("update");

    if (!conversation) return null;
    if (
      conversation.activeTurnClaimToken &&
      conversation.activeTurnClaimToken !== options.claimToken
    )
      return { status: "active" } as const;

    const [targetMessage] = await tx
      .select({
        id: ChatMessages.id,
        role: ChatMessages.role,
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
        desc(ChatMessages.role),
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
      .where(
        and(
          eq(Attachments.userId, userId),
          eq(Attachments.kind, "image"),
          deleteFilter,
        ),
      );

    const deletedMessages = await tx
      .delete(ChatMessages)
      .where(deleteFilter)
      .returning({ id: ChatMessages.id });

    const deletedImageUploadIds =
      await images.deleteOwnedUnlinkedUnreservedImageAttachments(
        userId,
        imageRows.map((image) => image.imageUploadId),
        tx,
      );

    await tx
      .update(Conversations)
      .set({ lastMessageId: newHead?.id ?? null, updatedAt: new Date() })
      .where(
        and(
          eq(Conversations.id, conversationId),
          eq(Conversations.userId, userId),
        ),
      );

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
export async function persistAndUnclaimChatTurn(turn: {
  userId: string;
  conversationId: string;
  content: string;
  attachmentIds: readonly string[];
  chosenModelId: string;
  assistantContent: string;
  /** The reply was stopped partway, so `assistantContent` is what came. */
  stopped?: boolean;
  sources?: StoredSource[];
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
          sources: turn.sources ?? [],
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
      turn.userId,
      turn.conversationId,
      turn.claimToken,
      assistantMessage.id,
      turn.conversationTitle,
      turn.contextWindowMessageCount,
      tx,
    );
    if (!completed) throw new Error("Conversation turn claim was lost");

    await attachments.unclaimAttachments(turn.claimToken, tx);

    return {
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
    };
  });
}
