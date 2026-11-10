import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
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
  schemaName: `context_history_test_${Date.now()}`,
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

vi.mock("../../src/storage/bucket", () => ({
  bucket: {},
}));

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
import {
  messages,
  type HistoryCandidate,
  type KnownHistoryText,
} from "../../src/data/messages.data";

const userId = "history-owner";
const conversationId = randomUUID();
const questionId = randomUUID();
const answerId = randomUUID();
const followUpId = randomUUID();
const firstAudioId = randomUUID();
const imageId = randomUUID();
const secondAudioId = randomUUID();

function read(knownText?: KnownHistoryText, beforeMessageId?: string) {
  return messages.findContextHistory({
    userId,
    conversationId,
    maximumMessageCount: 49,
    ...(knownText === undefined ? {} : { knownText }),
    ...(beforeMessageId === undefined ? {} : { beforeMessageId }),
  });
}

/** Everything a read returned, as the text cache would hold it. */
function knownFrom(history: readonly HistoryCandidate[]): KnownHistoryText {
  return {
    messages: new Map(history.map((message) => [message.id, message.content])),
    transcripts: new Map(
      history.flatMap((message) =>
        message.transcripts.map(
          (transcript) =>
            [transcript.audioUploadId, transcript.content] as const,
        ),
      ),
    ),
  };
}

// ATTACHMENT_TEST_DATABASE_URL enables these tests; each run creates and drops its own schema.
describe.skipIf(!testState.databaseUrl)("context history in PostgreSQL", () => {
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
    await db.insert(Conversations).values({
      id: conversationId,
      userId,
      contextWindowMessageCount: 3,
    });
    const at = (second: number) => new Date(`2026-10-21T00:00:0${second}.000Z`);
    await db.insert(ChatMessages).values([
      {
        id: questionId,
        role: "user",
        content: "Compare these",
        conversationId,
        userId,
        createdAt: at(1),
      },
      {
        id: answerId,
        role: "assistant",
        content: "They differ",
        sources: [
          { url: "https://a.test/", title: "A", content: "Page A" },
          { url: "https://cited.test/", title: "Cited" },
          { url: "https://b.test/", title: "b.test", unread: true },
          { url: "https://c.test/", title: "C", content: "Page C" },
        ],
        conversationId,
        userId,
        createdAt: at(2),
      },
      {
        id: followUpId,
        role: "user",
        content: "Why?",
        conversationId,
        userId,
        createdAt: at(3),
      },
    ]);
    await db.insert(Attachments).values([
      {
        attachmentId: firstAudioId,
        userId,
        kind: "audio",
        fileName: "a.mp3",
        sizeBytes: 1,
      },
      {
        attachmentId: imageId,
        userId,
        kind: "image",
        fileName: "i.png",
        sizeBytes: 1,
      },
      {
        attachmentId: secondAudioId,
        userId,
        kind: "audio",
        fileName: "b.mp3",
        sizeBytes: 1,
      },
    ]);
    await db.insert(AudioTranscriptionJobs).values([
      { audioUploadId: firstAudioId, source: "audio", status: "completed" },
      { audioUploadId: secondAudioId, source: "audio", status: "completed" },
    ]);
    await db.insert(TranscriptContents).values([
      {
        audioUploadId: firstAudioId,
        content: "First transcript",
        charCount: 16,
      },
      {
        audioUploadId: secondAudioId,
        content: "Second transcript",
        charCount: 17,
      },
    ]);
    await db.insert(ChatMessageAttachmentLinks).values([
      { messageId: questionId, attachmentId: firstAudioId, position: 0 },
      { messageId: questionId, attachmentId: imageId, position: 1 },
      { messageId: questionId, attachmentId: secondAudioId, position: 2 },
    ]);
  });

  it("brings back the text of the pages a recent reply read, in order", async () => {
    const history = await read();

    expect(history.map((message) => message.pages)).toEqual([
      [],
      [
        { url: "https://a.test/", title: "A", content: "Page A" },
        { url: "https://c.test/", title: "C", content: "Page C" },
      ],
      [],
    ]);
  });

  it("never lets the text of a page out with the messages", async () => {
    const rows = await messages.findConversationMessages(conversationId);

    expect(rows.find((row) => row.id === answerId)?.sources).toEqual([
      { url: "https://a.test/", title: "A" },
      { url: "https://cited.test/", title: "Cited" },
      { url: "https://b.test/", title: "b.test", unread: true },
      { url: "https://c.test/", title: "C" },
    ]);
    expect(rows.find((row) => row.id === questionId)?.sources).toEqual([]);
  });

  it("reads the window with each message's text and transcripts once", async () => {
    const history = await read();

    expect(history.map((message) => [message.id, message.content])).toEqual([
      [followUpId, "Why?"],
      [answerId, "They differ"],
      [questionId, "Compare these"],
    ]);
    expect(history[2].transcripts).toEqual([
      { audioUploadId: firstAudioId, content: "First transcript" },
      { audioUploadId: secondAudioId, content: "Second transcript" },
    ]);
    expect(history[2].images.map((image) => image.imageUploadId)).toEqual([
      imageId,
    ]);
  });

  it("returns the same history whether the text is known, partly known or not", async () => {
    const cold = await read();
    const known = knownFrom(cold);

    expect(await read(known)).toEqual(cold);
    expect(
      await read({
        messages: new Map([[questionId, "Compare these"]]),
        transcripts: new Map([[secondAudioId, "Second transcript"]]),
      }),
    ).toEqual(cold);
  });

  it("leaves known text out of what the database sends", async () => {
    const cold = await read();
    const execute = vi.spyOn(db, "execute");

    await read(knownFrom(cold));

    const rows = (await execute.mock.results[0].value) as {
      content: string | null;
      transcriptContent: string | null;
    }[];
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.content === null)).toBe(true);
    expect(rows.every((row) => row.transcriptContent === null)).toBe(true);
    execute.mockRestore();
  });

  it("sends a message's text once, however many attachments it has", async () => {
    const execute = vi.spyOn(db, "execute");

    await read();

    const rows = (await execute.mock.results[0].value) as {
      messageId: string;
      content: string | null;
    }[];
    expect(
      rows
        .filter((row) => row.messageId === questionId)
        .map((row) => row.content),
    ).toEqual(["Compare these", null, null]);
    execute.mockRestore();
  });

  it("lets the database decide the window, whatever the cache still holds", async () => {
    const known = knownFrom(await read());
    await db.execute(
      sql`delete from ${ChatMessages} where ${ChatMessages.id} = ${followUpId}`,
    );

    expect((await read(known)).map((message) => message.id)).toEqual([
      answerId,
      questionId,
    ]);
    expect((await read(known, answerId)).map((message) => message.id)).toEqual([
      questionId,
    ]);
  });
});
