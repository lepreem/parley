import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Sql } from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { exportSchemaSql } from "../helpers/schemaSql";

const testState = vi.hoisted(() => ({
  databaseUrl: process.env.ATTACHMENT_TEST_DATABASE_URL,
  schemaName: `immutable_rows_test_${Date.now()}`,
  client: null as Sql | null,
}));

vi.mock("../../src/db", async () => {
  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const schema = await import("../../src/db/schema");
  const client = postgres(
    testState.databaseUrl ?? "postgres://localhost/unused",
    {
      max: 5,
      connection: { search_path: testState.schemaName },
      onnotice: () => {},
    },
  );
  testState.client = client;
  return { ...schema, db: drizzle(client, { schema }) };
});

import {
  Attachments,
  AudioTranscriptionJobs,
  ChatMessageAttachmentLinks,
  ChatMessages,
  Conversations,
  TranscriptContents,
  db,
  users,
} from "../../src/db";
import { users as usersData } from "../../src/data/users.data";

const userId = "immutable-owner";
const conversationId = randomUUID();
const messageId = randomUUID();
const audioUploadId = randomUUID();

/** Drizzle wraps the database's error; the trigger's is its cause. */
function immutable(table: string) {
  return {
    cause: {
      code: "23001",
      message: `${table} rows are immutable: delete and insert instead`,
    },
  };
}

// ATTACHMENT_TEST_DATABASE_URL enables these tests; each run creates and drops its own schema.
describe.skipIf(!testState.databaseUrl)("written once, in PostgreSQL", () => {
  beforeAll(async () => {
    await db.execute(sql.raw(`create schema "${testState.schemaName}"`));
    const schemaSql = exportSchemaSql().replaceAll(
      '"public"',
      `"${testState.schemaName}"`,
    );
    await testState.client!.unsafe(schemaSql);
  });

  afterAll(async () => {
    await db.execute(sql.raw(`drop schema "${testState.schemaName}" cascade`));
    await testState.client!.end();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate ${users} cascade`);
    await db.insert(users).values({ id: userId });
    await db.insert(Conversations).values({ id: conversationId, userId });
    await db.insert(ChatMessages).values({
      id: messageId,
      role: "user",
      content: "Summarize this",
      conversationId,
      userId,
    });
    await db.insert(Attachments).values({
      attachmentId: audioUploadId,
      userId,
      kind: "audio",
      fileName: "a.mp3",
      sizeBytes: 1,
    });
    await db
      .insert(AudioTranscriptionJobs)
      .values({ audioUploadId, source: "audio", status: "completed" });
    await db.insert(TranscriptContents).values({
      audioUploadId,
      content: "The transcript",
      charCount: 14,
    });
    await db.insert(ChatMessageAttachmentLinks).values({
      messageId,
      attachmentId: audioUploadId,
      position: 0,
    });
  });

  it("refuses to update a message", async () => {
    await expect(
      db
        .update(ChatMessages)
        .set({ content: "Rewritten" })
        .where(eq(ChatMessages.id, messageId)),
    ).rejects.toMatchObject(immutable("chat_messages"));
    const [message] = await db.select().from(ChatMessages);
    expect(message?.content).toBe("Summarize this");
  });

  it("lets a message change owner", async () => {
    await db.insert(users).values({ id: "new-owner" });
    await db
      .update(ChatMessages)
      .set({ userId: "new-owner", updatedAt: sql`${ChatMessages.updatedAt}` })
      .where(eq(ChatMessages.id, messageId));
    const [message] = await db.select().from(ChatMessages);
    expect(message?.userId).toBe("new-owner");
  });

  it("refuses an owner change that bumps updated_at with it", async () => {
    await db.insert(users).values({ id: "new-owner" });
    await expect(
      db
        .update(ChatMessages)
        .set({ userId: "new-owner" })
        .where(eq(ChatMessages.id, messageId)),
    ).rejects.toMatchObject(immutable("chat_messages"));
  });

  it("refuses an owner change that changes anything else", async () => {
    await db.insert(users).values({ id: "new-owner" });
    await expect(
      db
        .update(ChatMessages)
        .set({ userId: "new-owner", content: "Rewritten" })
        .where(eq(ChatMessages.id, messageId)),
    ).rejects.toMatchObject(immutable("chat_messages"));
    const [message] = await db.select().from(ChatMessages);
    expect(message).toMatchObject({ userId, content: "Summarize this" });
  });

  it("refuses an update that changes nothing, where nothing is tolerated", async () => {
    await expect(
      db
        .update(TranscriptContents)
        .set({ content: sql`${TranscriptContents.content}` })
        .where(eq(TranscriptContents.audioUploadId, audioUploadId)),
    ).rejects.toMatchObject(immutable("transcript_contents"));
  });

  it("moves a guest's chats to an account and deletes the guest", async () => {
    const guestId = "guest_moving";
    const guestConversationId = randomUUID();
    const updatedAt = new Date("2026-01-02T03:04:05Z");
    await db.insert(users).values({ id: guestId });
    await db.insert(Conversations).values({
      id: guestConversationId,
      userId: guestId,
      updatedAt,
    });
    await db.insert(ChatMessages).values({
      id: randomUUID(),
      role: "user",
      content: "Hello",
      conversationId: guestConversationId,
      userId: guestId,
    });

    await usersData.adoptGuest(guestId, userId);

    const conversations = await db
      .select()
      .from(Conversations)
      .where(eq(Conversations.id, guestConversationId));
    expect(conversations).toMatchObject([{ userId, updatedAt }]);
    const messages = await db
      .select()
      .from(ChatMessages)
      .where(eq(ChatMessages.conversationId, guestConversationId));
    expect(messages).toMatchObject([{ userId, content: "Hello" }]);
    expect(await db.select().from(users).where(eq(users.id, guestId))).toEqual(
      [],
    );
  });

  it("refuses to update a message's attachment link", async () => {
    await expect(
      db
        .update(ChatMessageAttachmentLinks)
        .set({ position: 1 })
        .where(eq(ChatMessageAttachmentLinks.messageId, messageId)),
    ).rejects.toMatchObject(immutable("chat_message_attachments"));
  });

  it("refuses to update a transcript", async () => {
    await expect(
      db
        .update(TranscriptContents)
        .set({ content: "Rewritten" })
        .where(eq(TranscriptContents.audioUploadId, audioUploadId)),
    ).rejects.toMatchObject(immutable("transcript_contents"));
  });

  it("still deletes them, cascades included", async () => {
    await db.delete(Conversations).where(eq(Conversations.id, conversationId));
    await db.delete(Attachments).where(eq(Attachments.userId, userId));

    expect(await db.select().from(ChatMessages)).toEqual([]);
    expect(await db.select().from(ChatMessageAttachmentLinks)).toEqual([]);
    expect(await db.select().from(TranscriptContents)).toEqual([]);
  });
});
