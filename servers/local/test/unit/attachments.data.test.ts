import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockTransaction,
  mockLock,
  mockDelete,
  mockDeleteWhere,
  mockFrom,
  mockInsert,
  mockReturning,
  mockSelect,
  mockSelectWhere,
  mockSubqueryWhere,
  mockValues,
} = vi.hoisted(() => ({
  mockTransaction: vi.fn(),
  mockLock: vi.fn(),
  mockDelete: vi.fn(),
  mockDeleteWhere: vi.fn(),
  mockFrom: vi.fn(),
  mockInsert: vi.fn(),
  mockReturning: vi.fn(),
  mockSelect: vi.fn(),
  mockSelectWhere: vi.fn(),
  mockSubqueryWhere: vi.fn(),
  mockValues: vi.fn(),
}));

vi.mock("../../core/db", async () => ({
  db: {
    transaction: mockTransaction,
    delete: mockDelete,
    insert: mockInsert,
    select: mockSelect,
  },
  ...(await import("../helpers/dbTableStubs")).tableStubs,
}));

// The ledger update itself is covered by the storage ledger integration tests.
import { attachments } from "../../core/data/attachments.data";
import { Attachments, ChatMessageAttachmentLinks } from "../../core/db";

type AttachmentExecutor = NonNullable<
  Parameters<typeof attachments.createAttachment>[1]
>;

beforeEach(() => {
  vi.clearAllMocks();
  mockTransaction.mockImplementation((callback) =>
    callback({ select: mockSelect, insert: mockInsert, delete: mockDelete }),
  );
  mockLock.mockResolvedValue([]);
  mockInsert.mockReturnValue({ values: mockValues });
  mockValues.mockResolvedValue(undefined);
  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockImplementation((table) =>
    table === Attachments
      ? { where: mockSelectWhere }
      : { where: mockSubqueryWhere },
  );
  mockSelectWhere.mockReturnValue({
    orderBy: () => ({ for: mockLock }),
  });
  mockSubqueryWhere.mockReturnValue({});
  mockDelete.mockReturnValue({ where: mockDeleteWhere });
  mockDeleteWhere.mockReturnValue({ returning: mockReturning });
});

describe("attachments", () => {
  it("creates an attachment", async () => {
    const attachment = {
      attachmentId: "550e8400-e29b-41d4-a716-446655440000",
      kind: "image" as const,
      fileName: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 128,
    };

    await attachments.createAttachment(attachment);

    expect(mockInsert).toHaveBeenCalledWith(Attachments);
    expect(mockValues).toHaveBeenCalledWith(attachment);
  });

  it("creates an attachment through the supplied executor", async () => {
    const transactionValues = vi.fn().mockResolvedValue(undefined);
    const transactionInsert = vi.fn().mockReturnValue({
      values: transactionValues,
    });
    const transactionExecutor = {
      insert: transactionInsert,
    } as unknown as AttachmentExecutor;
    const attachment = {
      attachmentId: "650e8400-e29b-41d4-a716-446655440111",
      kind: "audio" as const,
      fileName: "interview.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 256,
    };

    await attachments.createAttachment(attachment, transactionExecutor);

    expect(transactionInsert).toHaveBeenCalledWith(Attachments);
    expect(transactionValues).toHaveBeenCalledWith(attachment);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns the attachment deleted by the guarded delete", async () => {
    mockReturning.mockResolvedValueOnce([
      { attachmentId: "image-attachment-1" },
    ]);

    await expect(
      attachments.deleteUnlinkedUnreservedAttachment({
        attachmentId: "image-attachment-1",
        kind: "image",
      }),
    ).resolves.toBe("image-attachment-1");
  });

  it("uses the supplied executor for the delete and its attachment check", async () => {
    const transactionSubqueryWhere = vi
      .fn()
      .mockReturnValue({ orderBy: () => ({ for: mockLock }) });
    const transactionFrom = vi.fn().mockReturnValue({
      where: transactionSubqueryWhere,
    });
    const transactionSelect = vi.fn().mockReturnValue({
      from: transactionFrom,
    });
    const transactionReturning = vi
      .fn()
      .mockResolvedValue([{ attachmentId: "image-attachment-1" }]);
    const transactionDeleteWhere = vi.fn().mockReturnValue({
      returning: transactionReturning,
    });
    const transactionDelete = vi.fn().mockReturnValue({
      where: transactionDeleteWhere,
    });
    const transactionExecutor = {
      delete: transactionDelete,
      select: transactionSelect,
    } as unknown as AttachmentExecutor;

    await expect(
      attachments.deleteUnlinkedUnreservedAttachments(
        {
          attachmentIds: ["image-attachment-1"],
          kind: "image",
        },
        transactionExecutor,
      ),
    ).resolves.toEqual(["image-attachment-1"]);

    expect(transactionDelete).toHaveBeenCalledWith(Attachments);
    expect(transactionFrom).toHaveBeenCalledWith(ChatMessageAttachmentLinks);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
