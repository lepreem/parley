import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/db", async () =>
  (await import("../helpers/inMemoryDb")).inMemoryDbModule(),
);

import { AttachmentTurnReservations, db } from "../../core/db";
import { data } from "../../core/data";
import { CLAIM_LEASE_MS } from "../../core/data/conversations.data";

describe("a reply's claims, renewed while it runs", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

  it("keeps a long reply's conversation claimed past the lease", async () => {
    const { id } = await data.conversations.createConversation();
    await data.conversations.claimConversationTurn(id, null, "reply-1");

    // A reply an hour long, renewing as it goes.
    for (let minute = 0; minute < 60; minute++) {
      later(60_000);
      expect(
        await data.conversations.renewConversationClaim(id, "reply-1"),
      ).toBe(true);
    }

    expect(
      await data.conversations.claimConversationTurn(id, null, "reply-2"),
    ).toBeNull();
  });

  it("still lets a claim lapse once nothing renews it", async () => {
    const { id } = await data.conversations.createConversation();
    await data.conversations.claimConversationTurn(id, null, "reply-1");

    later(CLAIM_LEASE_MS + 1);

    expect(
      await data.conversations.claimConversationTurn(id, null, "reply-2"),
    ).toBe("reply-2");
    // The one that lost it can't take it back.
    expect(await data.conversations.renewConversationClaim(id, "reply-1")).toBe(
      false,
    );
  });

  it("pushes back the reservations on only that reply's attachments", async () => {
    await data.attachments.createAttachment({
      attachmentId: "image-1",
      kind: "image",
      fileName: "a.png",
      mimeType: "image/png",
      sizeBytes: 1,
    });
    await data.attachments.claimAttachments(["image-1"], "reply-1");
    await data.attachments.claimAttachments(["image-1"], "reply-2");

    later(5 * 60_000);
    await data.attachments.renewAttachmentClaims("reply-1");

    const expiries = Object.fromEntries(
      (await db.select().from(AttachmentTurnReservations)).map((row) => [
        row.claimToken,
        row.expiresAt.getTime(),
      ]),
    );
    expect(expiries["reply-1"]).toBe(Date.now() + CLAIM_LEASE_MS);
    expect(expiries["reply-2"]).toBe(Date.now() - 5 * 60_000 + CLAIM_LEASE_MS);
  });
});
