import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import {
  Conversations,
  DEFAULT_CONVERSATION_TITLE,
  db,
  type Executor,
} from "../db";

const conversationColumns = {
  id: Conversations.id,
  title: Conversations.title,
  createdAt: Conversations.createdAt,
  updatedAt: Conversations.updatedAt,
  lastMessageId: Conversations.lastMessageId,
  activeTurnClaimToken: Conversations.activeTurnClaimToken,
};

export type ConversationRow = Pick<
  typeof Conversations.$inferSelect,
  keyof typeof conversationColumns
>;

/**
 * Most recently active first. `updatedAt` is touched by both posting a message
 * and renaming, so a revived old conversation surfaces back to the top.
 */
async function findConversations() {
  return db
    .select(conversationColumns)
    .from(Conversations)
    .orderBy(desc(Conversations.updatedAt), desc(Conversations.id));
}

/** Shared by every message route: null when there's no such conversation. */
async function findConversation(conversationId: string) {
  const [row] = await db
    .select(conversationColumns)
    .from(Conversations)
    .where(eq(Conversations.id, conversationId))
    .limit(1);

  return row ?? null;
}

/**
 * How long a claimed turn may be held before another claim may take it.
 *
 * A claim is normally cleared by an explicit release, but a process that dies
 * mid-turn never gets to release. Without an expiry that conversation returns
 * 409 for good.
 *
 * Longer than any turn can run: the model call is the only slow step, and
 * chatAI gives up on it after 8 minutes.
 */
export const CLAIM_LEASE_MS = 10 * 60 * 1000;

/**
 * No turn is holding this conversation: either nothing claimed it, or the
 * claim is old enough to assume the process holding it is gone. A row
 * predating this column has no timestamp and counts as expired — nobody can
 * release it either.
 */
export function claimIsFreeOrExpired(): SQL | undefined {
  return or(
    isNull(Conversations.activeTurnClaimToken),
    isNull(Conversations.activeTurnClaimedAt),
    lt(
      Conversations.activeTurnClaimedAt,
      new Date(Date.now() - CLAIM_LEASE_MS),
    ),
  );
}

async function claimConversationTurn(
  conversationId: string,
  expectedLastMessageId: string | null,
  claimToken: string = randomUUID(),
) {
  const [row] = await db
    .update(Conversations)
    .set({
      activeTurnClaimToken: claimToken,
      activeTurnClaimedAt: new Date(),
      updatedAt: sql`${Conversations.updatedAt}`,
    })
    .where(
      and(
        eq(Conversations.id, conversationId),
        claimIsFreeOrExpired(),
        expectedLastMessageId === null
          ? isNull(Conversations.lastMessageId)
          : eq(Conversations.lastMessageId, expectedLastMessageId),
      ),
    )
    .returning({ id: Conversations.id });

  return row ? claimToken : null;
}

async function unclaimConversationTurn(
  conversationId: string,
  claimToken: string,
  executor: Executor = db,
) {
  await executor
    .update(Conversations)
    .set({
      activeTurnClaimToken: null,
      activeTurnClaimedAt: null,
      updatedAt: sql`${Conversations.updatedAt}`,
    })
    .where(
      and(
        eq(Conversations.id, conversationId),
        eq(Conversations.activeTurnClaimToken, claimToken),
      ),
    );
}

async function completeConversationTurn(
  conversationId: string,
  claimToken: string,
  lastMessageId: string,
  conversationTitle: string | undefined,
  contextWindowMessageCount: number | undefined,
  executor: Executor = db,
) {
  const [row] = await executor
    .update(Conversations)
    .set({
      lastMessageId,
      activeTurnClaimToken: null,
      activeTurnClaimedAt: null,
      updatedAt: new Date(),
      ...(contextWindowMessageCount !== undefined
        ? { contextWindowMessageCount }
        : {}),
      ...(conversationTitle
        ? {
            title: sql<string>`case when ${Conversations.title} = ${DEFAULT_CONVERSATION_TITLE} then ${conversationTitle} else ${Conversations.title} end`,
          }
        : {}),
    })
    .where(
      and(
        eq(Conversations.id, conversationId),
        eq(Conversations.activeTurnClaimToken, claimToken),
      ),
    )
    .returning({ id: Conversations.id });

  return Boolean(row);
}

/** Omitting `title` leaves the column to its DB default. */
async function createConversation(title?: string) {
  const [row] = await db
    .insert(Conversations)
    .values(title !== undefined ? { title } : {})
    .returning(conversationColumns);

  return row;
}

async function renameConversation(conversationId: string, title: string) {
  const [row] = await db
    .update(Conversations)
    .set({ title, updatedAt: new Date() })
    .where(eq(Conversations.id, conversationId))
    .returning(conversationColumns);

  return row ?? null;
}

/** Null when there's no such conversation, which the caller reports as a 404. */
async function deleteConversation(conversationId: string) {
  const [row] = await db
    .delete(Conversations)
    .where(and(eq(Conversations.id, conversationId), claimIsFreeOrExpired()))
    .returning({ id: Conversations.id });

  return row ?? null;
}

export const conversations = {
  findConversations,
  findConversation,
  claimConversationTurn,
  unclaimConversationTurn,
  completeConversationTurn,
  createConversation,
  renameConversation,
  deleteConversation,
};
