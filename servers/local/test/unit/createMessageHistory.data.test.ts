import { beforeEach, describe, expect, it, vi } from "vitest";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";

const { mockAll } = vi.hoisted(() => ({ mockAll: vi.fn() }));

vi.mock("../../core/db", async () => ({
  db: { all: mockAll },
  ...(await import("../../core/db/schema")),
}));

vi.mock("../../core/data/images.data", () => ({
  images: {
    deleteUnlinkedUnreservedImageAttachments: vi.fn(),
  },
}));

import { messages } from "../../core/data/messages.data";

const createdAt = new Date("2026-08-31T00:00:00.000Z");

function historyRow(
  partial: Partial<{
    currentTurnContextCharCount: number;
    currentTranscriptCount: number;
    messageId: string | null;
    role: "user" | "assistant" | null;
    content: string | null;
    createdAt: number | null;
    attachmentId: string | null;
    attachmentKind: "image" | "audio" | null;
    attachmentMimeType: string | null;
    transcriptContent: string | null;
    transcriptCharCount: number | null;
  }> = {},
) {
  return {
    currentTurnContextCharCount: 10,
    currentTranscriptCount: 1,
    messageId: "message-1",
    role: "user" as const,
    content: "Question",
    createdAt: createdAt.getTime(),
    attachmentId: null,
    attachmentKind: null,
    attachmentMimeType: null,
    transcriptContent: null,
    transcriptCharCount: null,
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("findCreateMessageHistory", () => {
  it("admits history before resolving its image slots", async () => {
    mockAll.mockResolvedValueOnce([
      historyRow({
        messageId: "message-2",
        role: "assistant",
        content: "Answer",
      }),
      historyRow({
        attachmentId: "audio-1",
        attachmentKind: "audio",
        transcriptContent: "Transcript",
        transcriptCharCount: 10,
      }),
      historyRow({
        attachmentId: "image-1",
        attachmentKind: "image",
        attachmentMimeType: "image/png",
      }),
      historyRow({
        messageId: "message-0",
        content: "Older",
        attachmentId: "image-2",
        attachmentKind: "image",
      }),
    ]);

    await expect(
      messages.findCreateMessageHistory({
        conversationId: "conversation-1",
        newMessageContentCharCount: 8,
        newTranscriptUploadIds: ["current-audio"],
        transcriptSeparatorCharCount: 2,
        maximumContextCharCount: 36,
        maximumMessageCount: 49,
        maximumImageCount: 1,
      }),
    ).resolves.toEqual([
      {
        id: "message-2",
        role: "assistant",
        content: "Answer",
        createdAt,
        transcriptContents: [],
        images: [],
        contextCharCount: 6,
      },
      {
        id: "message-1",
        role: "user",
        content: "Question",
        createdAt,
        transcriptContents: ["Transcript"],
        images: [{ imageUploadId: "image-1", mimeType: "image/png" }],
        contextCharCount: 20,
      },
    ]);
    expect(mockAll).toHaveBeenCalledOnce();
    const query = mockAll.mock.calls[0][0];
    const compiledQuery = new SQLiteAsyncDialect().sqlToQuery(query);
    expect(compiledQuery.sql).toContain("context_window_message_count");
    expect(compiledQuery.sql).toContain("current_turn as");
    expect(compiledQuery.sql).toContain("recent_messages as");
    expect(compiledQuery.sql).not.toContain("admitted_messages");
  });
});
