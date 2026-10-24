import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/db", async () =>
  (await import("../helpers/inMemoryDb")).inMemoryDbModule(),
);

import { eq } from "drizzle-orm";
import {
  Attachments,
  ChatMessageAttachmentLinks,
  ChatMessages,
  Conversations,
  db,
  TranscriptContents,
} from "../../shared/db";
import { deleteAllRows } from "../helpers/inMemoryDb";
import { jobs } from "../../shared/data/jobs.data";
import { transcripts } from "../../shared/data/transcripts.data";

const conversationId = randomUUID();

/** A message with an image linked and a completed transcript. */
async function writtenMessage() {
  await db.insert(Conversations).values({ id: conversationId });
  const [message] = await db
    .insert(ChatMessages)
    .values({ role: "user", content: "question", conversationId })
    .returning({ id: ChatMessages.id });
  const imageUploadId = randomUUID();
  await db.insert(Attachments).values({
    attachmentId: imageUploadId,
    kind: "image",
    fileName: "diagram.png",
    mimeType: "image/png",
    sizeBytes: 6,
  });
  await db.insert(ChatMessageAttachmentLinks).values({
    messageId: message!.id,
    attachmentId: imageUploadId,
    position: 0,
  });

  const audioUploadId = randomUUID();
  await jobs.createAudioJob({
    audioUploadId,
    source: "audio",
    fileName: "talk.mp3",
    mimeType: "audio/mpeg",
    sizeBytes: 5,
    transcriptModelId: "small",
  });
  const job = await jobs.claimAudioJob(audioUploadId);
  await transcripts.saveCompletedTranscript(
    audioUploadId,
    [{ start: 1, end: 2, text: "Hello there" }],
    job!.claimToken,
  );
  return { messageId: message!.id, audioUploadId };
}

/** Drizzle wraps the database's error; the trigger's message is its cause. */
function immutable(table: string) {
  return {
    cause: { message: expect.stringContaining(`${table} rows are immutable`) },
  };
}

beforeEach(async () => {
  await deleteAllRows(db);
});

// The database refuses to rewrite them, so an edit has to delete and insert.
describe("written once", () => {
  it("refuses to update a message", async () => {
    const { messageId } = await writtenMessage();

    await expect(
      db
        .update(ChatMessages)
        .set({ content: "rewritten" })
        .where(eq(ChatMessages.id, messageId)),
    ).rejects.toMatchObject(immutable("chat_messages"));
    const [message] = await db.select().from(ChatMessages);
    expect(message?.content).toBe("question");
  });

  it("refuses to update a message's attachment link", async () => {
    const { messageId } = await writtenMessage();

    await expect(
      db
        .update(ChatMessageAttachmentLinks)
        .set({ position: 1 })
        .where(eq(ChatMessageAttachmentLinks.messageId, messageId)),
    ).rejects.toMatchObject(immutable("chat_message_attachments"));
  });

  it("refuses to update a transcript", async () => {
    const { audioUploadId } = await writtenMessage();

    await expect(
      db
        .update(TranscriptContents)
        .set({ content: "rewritten" })
        .where(eq(TranscriptContents.audioUploadId, audioUploadId)),
    ).rejects.toMatchObject(immutable("transcript_contents"));
  });

  it("still deletes them, cascades included", async () => {
    await writtenMessage();

    await deleteAllRows(db);

    expect(await db.select().from(ChatMessages)).toEqual([]);
    expect(await db.select().from(ChatMessageAttachmentLinks)).toEqual([]);
    expect(await db.select().from(TranscriptContents)).toEqual([]);
  });
});
