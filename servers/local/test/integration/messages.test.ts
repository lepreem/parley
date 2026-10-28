import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/db", async () =>
  (await import("../helpers/inMemoryDb")).inMemoryDbModule(),
);

import { eq } from "drizzle-orm";
import {
  Attachments,
  ChatMessageAttachmentLinks,
  ChatMessages,
  Conversations,
  db,
} from "../../core/db";
import { deleteAllRows } from "../helpers/inMemoryDb";
import { CLAIM_LEASE_MS } from "../../core/data/conversations.data";
import { messages } from "../../core/data/messages.data";

const conversationId = randomUUID();

describe("message order", () => {
  beforeEach(async () => {
    await deleteAllRows(db);
    await db.insert(Conversations).values({ id: conversationId });
  });

  // A turn's two messages are written together and can share a timestamp.
  it("puts a turn's user message before its assistant message", async () => {
    const createdAt = new Date();
    // The assistant's is written first, so insertion order can't be what
    // decides.
    await db.insert(ChatMessages).values([
      {
        role: "assistant",
        content: "answer",
        conversationId,
        createdAt,
      },
      { role: "user", content: "question", conversationId, createdAt },
    ]);

    const oldestFirst = await messages.findConversationMessages(conversationId);
    expect(oldestFirst.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);

    // What the model is handed, newest first so the limit keeps the latest.
    // The history is as long as the conversation's context window.
    await db
      .update(Conversations)
      .set({ contextWindowMessageCount: 2 })
      .where(eq(Conversations.id, conversationId));
    const newestFirst = await messages.findCreateMessageHistory({
      conversationId,
      newMessageContentCharCount: 0,
      newTranscriptUploadIds: [],
      transcriptSeparatorCharCount: 2,
      maximumContextCharCount: 100_000,
      maximumMessageCount: 2,
      maximumImageCount: 0,
    });
    expect(newestFirst.map((message) => message.role)).toEqual([
      "assistant",
      "user",
    ]);
  });
});

describe("deleteMessage", () => {
  beforeEach(async () => {
    await deleteAllRows(db);
    await db.insert(Conversations).values({ id: conversationId });
  });

  /** A turn of two messages, a second apart from the turn before. */
  async function turn(index: number, imageUploadId?: string) {
    const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
    const [question, answer] = await db
      .insert(ChatMessages)
      .values([
        { role: "user", content: `q${index}`, conversationId, createdAt },
        { role: "assistant", content: `a${index}`, conversationId, createdAt },
      ])
      .returning({ id: ChatMessages.id });
    if (imageUploadId) {
      await db.insert(Attachments).values({
        attachmentId: imageUploadId,
        kind: "image",
        fileName: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 6,
      });
      await db.insert(ChatMessageAttachmentLinks).values({
        messageId: question!.id,
        attachmentId: imageUploadId,
        position: 0,
      });
    }
    await db
      .update(Conversations)
      .set({ lastMessageId: answer!.id })
      .where(eq(Conversations.id, conversationId));
    return { questionId: question!.id, answerId: answer!.id };
  }

  async function remainingContents() {
    const rows = await messages.findConversationMessages(conversationId);
    return rows.map((row) => row.content);
  }

  it("deletes the message and everything after it, moving the head back", async () => {
    const first = await turn(1);
    const second = await turn(2);
    const imageUploadId = randomUUID();
    const third = await turn(3, imageUploadId);

    const result = await messages.deleteMessage(
      conversationId,
      second.questionId,
    );

    expect(result).toEqual({
      status: "deleted",
      ids: expect.arrayContaining([
        second.questionId,
        second.answerId,
        third.questionId,
        third.answerId,
      ]),
      imageUploadIds: [imageUploadId],
      lastMessageId: first.answerId,
    });
    expect(await remainingContents()).toEqual(["q1", "a1"]);
    expect(await db.select().from(Attachments)).toEqual([]);
    const [conversation] = await db.select().from(Conversations);
    expect(conversation?.lastMessageId).toBe(first.answerId);
  });

  it("refuses while a response owns the conversation", async () => {
    const first = await turn(1);
    await db
      .update(Conversations)
      .set({
        activeTurnClaimToken: randomUUID(),
        activeTurnClaimedAt: new Date(),
      })
      .where(eq(Conversations.id, conversationId));

    expect(
      await messages.deleteMessage(conversationId, first.questionId),
    ).toEqual({ status: "active" });
    expect(await remainingContents()).toEqual(["q1", "a1"]);
  });

  it("deletes past a claim whose lease has run out", async () => {
    const first = await turn(1);
    await db
      .update(Conversations)
      .set({
        activeTurnClaimToken: randomUUID(),
        activeTurnClaimedAt: new Date(Date.now() - CLAIM_LEASE_MS - 1_000),
      })
      .where(eq(Conversations.id, conversationId));

    expect(
      await messages.deleteMessage(conversationId, first.questionId),
    ).toMatchObject({ status: "deleted" });
  });

  it("deletes under the caller's own claim", async () => {
    const first = await turn(1);
    const claimToken = randomUUID();
    await db
      .update(Conversations)
      .set({
        activeTurnClaimToken: claimToken,
        activeTurnClaimedAt: new Date(),
      })
      .where(eq(Conversations.id, conversationId));

    expect(
      await messages.deleteMessage(conversationId, first.questionId, {
        claimToken,
      }),
    ).toMatchObject({ status: "deleted", lastMessageId: null });
  });

  it("refuses a message of another role than the one asked for", async () => {
    const first = await turn(1);

    expect(
      await messages.deleteMessage(conversationId, first.answerId, {
        onlyRole: "user",
      }),
    ).toEqual({ status: "wrong_role" });
    expect(await remainingContents()).toEqual(["q1", "a1"]);
  });

  it("finds nothing for a message in another conversation", async () => {
    const otherConversationId = randomUUID();
    await db.insert(Conversations).values({ id: otherConversationId });
    const first = await turn(1);

    expect(
      await messages.deleteMessage(otherConversationId, first.questionId),
    ).toBeNull();
    expect(await remainingContents()).toEqual(["q1", "a1"]);
  });
});
