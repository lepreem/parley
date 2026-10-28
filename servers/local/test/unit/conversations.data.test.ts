import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUpdate, mockSet, mockWhere, mockReturning } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockSet: vi.fn(),
  mockWhere: vi.fn(),
  mockReturning: vi.fn(),
}));

vi.mock("../../core/db", async () => ({
  db: { update: mockUpdate },
  ...(await import("../helpers/dbTableStubs")).tableStubs,
}));

import { conversations } from "../../core/data/conversations.data";

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockReturnValue({ set: mockSet });
  mockSet.mockReturnValue({ where: mockWhere });
  mockWhere.mockReturnValue({ returning: mockReturning });
});

describe("conversation turn claims", () => {
  it("returns the token written by a successful claim", async () => {
    mockReturning.mockResolvedValueOnce([{ id: "conversation-1" }]);

    const claimToken = await conversations.claimConversationTurn(
      "conversation-1",
      null,
    );

    expect(claimToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(mockSet).toHaveBeenCalledWith({
      activeTurnClaimToken: claimToken,
      activeTurnClaimedAt: expect.any(Date),
      updatedAt: expect.anything(),
    });
  });

  it("returns null when the expected conversation head cannot be claimed", async () => {
    mockReturning.mockResolvedValueOnce([]);

    await expect(
      conversations.claimConversationTurn("conversation-1", "message-1"),
    ).resolves.toBeNull();
  });

  it("uses a supplied token so other reservations can start independently", async () => {
    mockReturning.mockResolvedValueOnce([{ id: "conversation-1" }]);

    await expect(
      conversations.claimConversationTurn(
        "conversation-1",
        null,
        "shared-token",
      ),
    ).resolves.toBe("shared-token");
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ activeTurnClaimToken: "shared-token" }),
    );
  });

  it("releases only the caller's claim token", async () => {
    await conversations.unclaimConversationTurn("conversation-1", "claim-1");

    expect(mockSet).toHaveBeenCalledWith({
      activeTurnClaimToken: null,
      activeTurnClaimedAt: null,
      updatedAt: expect.anything(),
    });
    expect(mockWhere).toHaveBeenCalledOnce();
  });

  it("advances the head only for the active claimant", async () => {
    mockReturning.mockResolvedValueOnce([{ id: "conversation-1" }]);

    await expect(
      conversations.completeConversationTurn(
        "conversation-1",
        "claim-1",
        "assistant-message-1",
        "Planning the next quarter",
        4,
      ),
    ).resolves.toBe(true);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        activeTurnClaimToken: null,
        activeTurnClaimedAt: null,
        contextWindowMessageCount: 4,
        lastMessageId: "assistant-message-1",
        title: expect.anything(),
      }),
    );
  });
});
