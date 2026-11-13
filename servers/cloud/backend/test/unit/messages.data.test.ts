import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockTransaction,
  mockSelect,
  mockDelete,
  mockDeleteWhere,
  mockDeleteReturning,
  mockInsert,
  mockValues,
  mockInsertReturning,
  mockUpdate,
  mockSet,
  mockUpdateWhere,
  mockLinkTranscriptions,
  mockCompleteConversationTurn,
  mockDeleteImageAttachments,
} = vi.hoisted(() => ({
  mockTransaction: vi.fn(),
  mockSelect: vi.fn(),
  mockDelete: vi.fn(),
  mockDeleteWhere: vi.fn(),
  mockDeleteReturning: vi.fn(),
  mockInsert: vi.fn(),
  mockValues: vi.fn(),
  mockInsertReturning: vi.fn(),
  mockUpdate: vi.fn(),
  mockSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockLinkTranscriptions: vi.fn(),
  mockCompleteConversationTurn: vi.fn(),
  mockDeleteImageAttachments: vi.fn(),
}));

const transaction = {
  select: mockSelect,
  delete: mockDelete,
  insert: mockInsert,
  update: mockUpdate,
};

vi.mock("../../src/db", async () => ({
  db: { transaction: mockTransaction },
  ...(await import("../helpers/dbTableStubs")).tableStubs,
}));

vi.mock("../../src/data/images.data", () => ({
  linkImagesToMessage: vi.fn(),
  deleteOwnedUnlinkedUnreservedImageAttachments: mockDeleteImageAttachments,
}));

vi.mock("../../src/data/conversations.data", () => ({
  completeConversationTurn: mockCompleteConversationTurn,
}));

vi.mock("../../src/data/transcripts.data", () => ({
  linkTranscriptionsToMessage: mockLinkTranscriptions,
  findMessageTranscriptAttachments: vi.fn(),
}));

import * as messages from "../../src/data/messages.data";

function returnLockedConversation(rows: unknown[]) {
  mockSelect.mockReturnValueOnce({
    from: () => ({
      where: () => ({
        limit: () => ({ for: vi.fn().mockResolvedValue(rows) }),
      }),
    }),
  });
}

function returnNewHead(rows: unknown[]) {
  mockSelect.mockReturnValueOnce({
    from: () => ({
      where: () => ({
        orderBy: () => ({ limit: vi.fn().mockResolvedValue(rows) }),
      }),
    }),
  });
}

function returnTargetMessage(rows: unknown[]) {
  mockSelect.mockReturnValueOnce({
    from: () => ({
      where: () => ({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  });
}

/** The images on the messages a delete removes: links joined to attachments and messages. */
function returnImageRows(rows: unknown[]) {
  mockSelect.mockReturnValueOnce({
    from: () => ({
      innerJoin: () => ({
        innerJoin: () => ({ where: vi.fn().mockResolvedValue(rows) }),
      }),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTransaction.mockImplementation(
    async (callback: (executor: typeof transaction) => unknown) =>
      callback(transaction),
  );
  mockDelete.mockReturnValue({ where: mockDeleteWhere });
  mockDeleteWhere.mockReturnValue({ returning: mockDeleteReturning });
  mockInsert.mockReturnValue({ values: mockValues });
  mockValues.mockReturnValue({ returning: mockInsertReturning });
  mockUpdate.mockReturnValue({ set: mockSet });
  mockSet.mockReturnValue({ where: mockUpdateWhere });
  mockUpdateWhere.mockResolvedValue(undefined);
});

describe("deleteOwnedMessage", () => {
  it("does not delete while a response owns the conversation", async () => {
    returnLockedConversation([
      { activeTurnClaimToken: "claim-token", lastMessageId: "message-1" },
    ]);

    await expect(
      messages.deleteOwnedMessage("user-1", "conversation-1", "message-1"),
    ).resolves.toEqual({ status: "active" });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("deletes the target and later messages, then moves the head back", async () => {
    returnLockedConversation([
      { activeTurnClaimToken: null, lastMessageId: "message-2" },
    ]);
    returnTargetMessage([
      { id: "message-2", role: "assistant", createdAt: new Date(2) },
    ]);
    returnNewHead([{ id: "message-1" }]);
    returnImageRows([
      { imageUploadId: "image-1" },
      { imageUploadId: "image-2" },
    ]);
    mockDeleteReturning.mockResolvedValueOnce([
      { id: "message-2" },
      { id: "message-3" },
    ]);
    // image-2 is still linked from an earlier message, so it stays.
    mockDeleteImageAttachments.mockResolvedValueOnce(["image-1"]);

    await expect(
      messages.deleteOwnedMessage("user-1", "conversation-1", "message-2"),
    ).resolves.toEqual({
      status: "deleted",
      ids: ["message-2", "message-3"],
      imageUploadIds: ["image-1"],
      lastMessageId: "message-1",
    });
    // Its images go too, in the same transaction, unless something still
    // links or reserves them.
    expect(mockDeleteImageAttachments).toHaveBeenCalledWith(
      "user-1",
      ["image-1", "image-2"],
      transaction,
    );
    expect(mockSet).toHaveBeenCalledWith({
      lastMessageId: "message-1",
      updatedAt: expect.any(Date),
    });
  });

  it("returns null when the target message is not owned by the conversation", async () => {
    returnLockedConversation([
      { activeTurnClaimToken: null, lastMessageId: "message-2" },
    ]);
    returnTargetMessage([]);

    await expect(
      messages.deleteOwnedMessage("user-1", "conversation-1", "message-1"),
    ).resolves.toBeNull();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
