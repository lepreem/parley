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
import { files } from "../../core/files";
import { createApp } from "../../api/app";
import { originHeaders } from "../helpers/headers";
import { deleteAllRows } from "../helpers/inMemoryDb";

type ConversationJson = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

async function request(path: string, init: RequestInit = {}) {
  return (await createApp()).request(`http://localhost${path}`, {
    ...init,
    headers: { ...originHeaders(), ...init.headers },
  });
}

function sendJson(path: string, method: string, body: unknown) {
  return request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A conversation created through the route. */
async function createdConversation(title = "My chat") {
  const res = await sendJson("/conversations", "POST", {
    conversationTitle: title,
  });
  return (await res.json()) as ConversationJson;
}

/** A user message in the conversation, carrying a stored image. */
async function messageWithImage(conversationId: string) {
  const messageId = randomUUID();
  const imageUploadId = randomUUID();
  await files.write(
    { kind: "image", uploadId: imageUploadId },
    Buffer.from("pixels"),
  );
  await db.insert(Attachments).values({
    attachmentId: imageUploadId,
    kind: "image",
    fileName: "diagram.png",
    mimeType: "image/png",
    sizeBytes: 6,
  });
  await db.insert(ChatMessages).values({
    id: messageId,
    conversationId,
    role: "user",
    content: "Look",
  });
  await db.insert(ChatMessageAttachmentLinks).values({
    messageId,
    attachmentId: imageUploadId,
    position: 0,
  });
  return imageUploadId;
}

beforeEach(async () => {
  await deleteAllRows(db);
});

describe("GET /conversations", () => {
  it("lists every conversation, most recently active first", async () => {
    const older = await createdConversation("Older");
    const newer = await createdConversation("Newer");
    // Posting a message bumps updatedAt, so an old conversation the user just
    // replied in comes back to the top.
    await db
      .update(Conversations)
      .set({ updatedAt: new Date(Date.now() + 60_000) })
      .where(eq(Conversations.id, older.id));

    const res = await request("/conversations");

    expect(res.status).toBe(200);
    const { conversations } = (await res.json()) as {
      conversations: ConversationJson[];
    };
    expect(conversations.map((conversation) => conversation.id)).toEqual([
      older.id,
      newer.id,
    ]);
  });
});

describe("GET /conversations/:conversationId", () => {
  it("returns the conversation", async () => {
    const conversation = await createdConversation();

    const res = await request(`/conversations/${conversation.id}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(conversation);
  });

  it("returns 404 when the conversation does not exist", async () => {
    expect((await request(`/conversations/${randomUUID()}`)).status).toBe(404);
  });

  it("rejects a non-uuid id with 400", async () => {
    expect((await request("/conversations/not-a-uuid")).status).toBe(400);
  });
});

describe("POST /conversations", () => {
  it("creates a conversation with the given title", async () => {
    const res = await sendJson("/conversations", "POST", {
      conversationTitle: "My chat",
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      title: "My chat",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it("creates a conversation without a body, under the default title", async () => {
    const res = await request("/conversations", { method: "POST" });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ title: "New conversation" });
  });

  it("rejects an empty title with 400, creating nothing", async () => {
    const res = await sendJson("/conversations", "POST", {
      conversationTitle: "   ",
    });

    expect(res.status).toBe(400);
    expect(await db.select().from(Conversations)).toEqual([]);
  });
});

describe("PATCH /conversations/:conversationId", () => {
  it("renames the conversation", async () => {
    const conversation = await createdConversation();

    const res = await sendJson(`/conversations/${conversation.id}`, "PATCH", {
      conversationTitle: "Renamed",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: conversation.id,
      title: "Renamed",
    });
  });

  it("returns 404 when the conversation does not exist", async () => {
    const res = await sendJson(`/conversations/${randomUUID()}`, "PATCH", {
      conversationTitle: "Renamed",
    });

    expect(res.status).toBe(404);
  });

  it("rejects a missing title with 400", async () => {
    const conversation = await createdConversation();

    const res = await sendJson(
      `/conversations/${conversation.id}`,
      "PATCH",
      {},
    );

    expect(res.status).toBe(400);
  });
});

describe("DELETE /conversations/:conversationId", () => {
  it("deletes the conversation, its messages and their images", async () => {
    const conversation = await createdConversation();
    const imageUploadId = await messageWithImage(conversation.id);

    const res = await request(`/conversations/${conversation.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "Conversation deleted" });
    expect(await db.select().from(Conversations)).toEqual([]);
    expect(await db.select().from(ChatMessages)).toEqual([]);
    expect(await db.select().from(Attachments)).toEqual([]);
    await expect(
      files.read({ kind: "image", uploadId: imageUploadId }),
    ).rejects.toThrow();
  });

  it("returns 404 when the conversation does not exist", async () => {
    const res = await request(`/conversations/${randomUUID()}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
  });

  it("returns 409 while the conversation has an active response, keeping everything", async () => {
    const conversation = await createdConversation();
    const imageUploadId = await messageWithImage(conversation.id);
    await db
      .update(Conversations)
      .set({
        activeTurnClaimToken: randomUUID(),
        activeTurnClaimedAt: new Date(),
      })
      .where(eq(Conversations.id, conversation.id));

    const res = await request(`/conversations/${conversation.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      message: "A response is already in progress",
    });
    expect(await db.select().from(Conversations)).toHaveLength(1);
    expect(
      await files.read({ kind: "image", uploadId: imageUploadId }),
    ).toEqual(Buffer.from("pixels"));
  });
});
