import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const { mockExecute } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
}));

vi.mock("../../src/db", async () => ({
  db: { execute: mockExecute },
  ...(await import("../../src/db/schema")),
}));

import { messages } from "../../src/data/messages.data";

const createdAt = new Date("2026-08-31T00:00:00.000Z");

function historyRow(
  partial: Partial<{
    messageId: string;
    role: "user" | "assistant";
    content: string | null;
    createdAt: string;
    attachmentId: string | null;
    attachmentKind: "image" | "audio" | null;
    signedUrl: string | null;
    signedUrlExpiresAt: string | null;
    transcriptAudioUploadId: string | null;
    transcriptContent: string | null;
    pages: { url: string; title: string; content: string }[] | null;
  }> = {},
) {
  return {
    messageId: "message-1",
    role: "user" as const,
    content: "Question",
    createdAt: createdAt.toISOString(),
    attachmentId: null,
    attachmentKind: null,
    signedUrl: null,
    signedUrlExpiresAt: null,
    pages: null,
    transcriptAudioUploadId: null,
    transcriptContent: null,
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("findContextHistory", () => {
  it("groups each turn with its transcripts, stored images and pages read, newest first", async () => {
    const page = { url: "https://a.test/", title: "A", content: "Page" };
    mockExecute.mockResolvedValueOnce([
      historyRow({
        messageId: "message-2",
        role: "assistant",
        content: "Answer",
        pages: [page],
      }),
      historyRow({
        attachmentId: "audio-1",
        attachmentKind: "audio",
        transcriptAudioUploadId: "audio-1",
        transcriptContent: "First transcript",
      }),
      historyRow({
        content: null,
        attachmentId: "audio-2",
        attachmentKind: "audio",
        transcriptAudioUploadId: "audio-2",
        transcriptContent: "Second transcript",
      }),
      historyRow({
        content: null,
        attachmentId: "image-1",
        attachmentKind: "image",
        signedUrl: "old-url",
        signedUrlExpiresAt: createdAt.toISOString(),
      }),
    ]);

    await expect(
      messages.findContextHistory({
        userId: "user-1",
        conversationId: "conversation-1",
        maximumMessageCount: 49,
      }),
    ).resolves.toEqual([
      {
        id: "message-2",
        role: "assistant",
        content: "Answer",
        createdAt,
        transcripts: [],
        pages: [page],
        images: [],
      },
      {
        id: "message-1",
        role: "user",
        content: "Question",
        createdAt,
        transcripts: [
          { audioUploadId: "audio-1", content: "First transcript" },
          { audioUploadId: "audio-2", content: "Second transcript" },
        ],
        pages: [],
        images: [
          {
            imageUploadId: "image-1",
            signedUrl: "old-url",
            signedUrlExpiresAt: createdAt,
          },
        ],
      },
    ]);
  });

  it("reads the window in one query, leaving admission to the caller", async () => {
    mockExecute.mockResolvedValueOnce([]);

    await expect(
      messages.findContextHistory({
        userId: "user-1",
        conversationId: "conversation-1",
        maximumMessageCount: 49,
      }),
    ).resolves.toEqual([]);

    expect(mockExecute).toHaveBeenCalledOnce();
    const query = new PgDialect().sqlToQuery(mockExecute.mock.calls[0][0]);
    expect(query.sql).toContain("context_window_message_count");
    expect(query.sql).toContain("recent_messages as");
    expect(query.sql).not.toContain("current_turn");
  });

  it("fills in the text it was told it needn't send", async () => {
    mockExecute.mockResolvedValueOnce([
      historyRow({ messageId: "message-2", role: "assistant", content: null }),
      historyRow({
        content: null,
        attachmentId: "audio-1",
        attachmentKind: "audio",
        transcriptAudioUploadId: "audio-1",
      }),
    ]);

    const history = await messages.findContextHistory({
      userId: "user-1",
      conversationId: "conversation-1",
      maximumMessageCount: 49,
      knownText: {
        messages: new Map([
          ["message-1", "Known question"],
          ["message-2", "Known answer"],
        ]),
        transcripts: new Map([["audio-1", "Known transcript"]]),
      },
    });

    expect(history.map((message) => message.content)).toEqual([
      "Known answer",
      "Known question",
    ]);
    expect(history[1].transcripts).toEqual([
      { audioUploadId: "audio-1", content: "Known transcript" },
    ]);
    const query = new PgDialect().sqlToQuery(mockExecute.mock.calls[0][0]);
    expect(query.params).toContain('{"message-1","message-2"}');
    expect(query.params).toContain('{"audio-1"}');
  });

  it("refuses to hand back a turn whose text it has nowhere to get", async () => {
    mockExecute.mockResolvedValueOnce([historyRow({ content: null })]);

    await expect(
      messages.findContextHistory({
        userId: "user-1",
        conversationId: "conversation-1",
        maximumMessageCount: 49,
      }),
    ).rejects.toThrow("History text missing for message-1");
  });
});
