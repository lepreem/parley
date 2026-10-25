import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/db", async () =>
  (await import("../helpers/inMemoryDb")).inMemoryDbModule(),
);

import {
  AttachmentTurnReservations,
  Attachments,
  ChatMessageAttachmentLinks,
  Conversations,
  db,
} from "../../core/db";
import { attachments } from "../../core/data/attachments.data";
import { images } from "../../core/data/images.data";
import { messages } from "../../core/data/messages.data";
import { deleteAllRows } from "../helpers/inMemoryDb";

const imageUploadId = randomUUID();
const audioUploadId = randomUUID();
const conversationId = randomUUID();
const claimToken = randomUUID();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe("attachment reservations", () => {
  beforeEach(async () => {
    await deleteAllRows(db);
    await db.insert(Conversations).values({
      id: conversationId,
      activeTurnClaimToken: claimToken,
      activeTurnClaimedAt: new Date(),
    });
    await db.insert(Attachments).values([
      {
        attachmentId: imageUploadId,
        kind: "image",
        fileName: "image.png",
        sizeBytes: 10,
      },
      {
        attachmentId: audioUploadId,
        kind: "audio",
        fileName: "audio.mp3",
        sizeBytes: 20,
      },
    ]);
  });

  it("reserves all requested attachments or none", async () => {
    expect(
      await attachments.claimAttachments(
        [imageUploadId, "missing"],
        claimToken,
      ),
    ).toBe(false);
    expect(await db.select().from(AttachmentTurnReservations)).toEqual([]);
  });

  it("deduplicates IDs and retains the reservation expiry", async () => {
    const startedAt = Date.now();
    expect(
      await attachments.claimAttachments(
        [imageUploadId, imageUploadId],
        claimToken,
      ),
    ).toBe(true);
    const rows = await db.select().from(AttachmentTurnReservations);
    expect(rows).toHaveLength(1);
    expect(rows[0].expiresAt.getTime()).toBeGreaterThanOrEqual(
      startedAt + 600_000,
    );
    expect(rows[0].claimToken).toBe(claimToken);
  });

  it("allows concurrent reservations with reversed input order", async () => {
    expect(
      await Promise.all([
        attachments.claimAttachments(
          [imageUploadId, audioUploadId],
          randomUUID(),
        ),
        attachments.claimAttachments(
          [audioUploadId, imageUploadId],
          randomUUID(),
        ),
      ]),
    ).toEqual([true, true]);
    expect(await db.select().from(AttachmentTurnReservations)).toHaveLength(4);
  });

  it("protects images and transcripts until the completed turn links them", async () => {
    expect(
      await attachments.claimAttachments(
        [imageUploadId, audioUploadId],
        claimToken,
      ),
    ).toBe(true);
    expect(
      await images.deleteUnlinkedUnreservedImageAttachment(imageUploadId),
    ).toBeNull();
    expect(
      await attachments.deleteUnlinkedUnreservedAttachments({
        attachmentIds: [audioUploadId],
        kind: "audio",
      }),
    ).toEqual([]);

    await messages.persistAndUnclaimChatTurn({
      conversationId,
      content: "Summarize",
      attachmentIds: [imageUploadId, audioUploadId],
      chosenModelId: "test-model",
      assistantContent: "Summary",
      contextWindowMessageCount: 2,
      claimToken,
    });
    expect(await db.select().from(ChatMessageAttachmentLinks)).toHaveLength(2);
    expect(await db.select().from(AttachmentTurnReservations)).toEqual([]);
    expect(
      await images.deleteUnlinkedUnreservedImageAttachment(imageUploadId),
    ).toBeNull();
  });

  it("releases only the failed turn's reservation when attachments are shared", async () => {
    const otherClaimToken = randomUUID();
    await attachments.claimAttachments([imageUploadId], claimToken);
    await attachments.claimAttachments([imageUploadId], otherClaimToken);
    await attachments.unclaimAttachments(claimToken);
    expect(
      await images.deleteUnlinkedUnreservedImageAttachment(imageUploadId),
    ).toBeNull();
    await attachments.unclaimAttachments(otherClaimToken);
    expect(
      await images.deleteUnlinkedUnreservedImageAttachment(imageUploadId),
    ).toBe(imageUploadId);
  });

  it("keeps reservations when persistence rolls back", async () => {
    await attachments.claimAttachments([imageUploadId], claimToken);
    await db.update(Conversations).set({ activeTurnClaimToken: randomUUID() });

    await expect(
      messages.persistAndUnclaimChatTurn({
        conversationId,
        content: "Describe",
        attachmentIds: [imageUploadId],
        chosenModelId: "test-model",
        assistantContent: "Description",
        contextWindowMessageCount: 2,
        claimToken,
      }),
    ).rejects.toThrow("Conversation turn claim was lost");

    expect(await db.select().from(ChatMessageAttachmentLinks)).toEqual([]);
    expect(await db.select().from(AttachmentTurnReservations)).toHaveLength(1);
    await attachments.unclaimAttachments(claimToken);
    expect(
      await images.deleteUnlinkedUnreservedImageAttachment(imageUploadId),
    ).toBe(imageUploadId);
  });

  it("protects an expired reservation while its conversation claim still exists", async () => {
    await attachments.claimAttachments([imageUploadId], claimToken);
    await db.update(AttachmentTurnReservations).set({ expiresAt: new Date(0) });
    expect(
      await images.deleteUnlinkedUnreservedImageAttachment(imageUploadId),
    ).toBeNull();

    await db.update(Conversations).set({ activeTurnClaimToken: null });
    expect(
      await images.deleteUnlinkedUnreservedImageAttachment(imageUploadId),
    ).toBe(imageUploadId);
  });

  it("waits for an ongoing image deletion and rejects reservation if deletion wins", async () => {
    const deleted = deferred();
    const finishDeletion = deferred();
    const deletion = db.transaction(async (transaction) => {
      await attachments.deleteUnlinkedUnreservedAttachment(
        { attachmentId: imageUploadId, kind: "image" },
        transaction,
      );
      deleted.resolve();
      await finishDeletion.promise;
    });
    await deleted.promise;
    const reservation = attachments.claimAttachments(
      [imageUploadId],
      claimToken,
    );
    // The database queues it behind the open transaction, so it can only
    // run once that transaction commits.
    finishDeletion.resolve();
    await deletion;
    expect(await reservation).toBe(false);
    expect(await db.select().from(AttachmentTurnReservations)).toEqual([]);
  });

  it("rechecks reservations after a delete waits for the attachment lock", async () => {
    const reservationStarted = deferred();
    const finishReservation = deferred();
    const reservation = db.transaction(async (transaction) => {
      await transaction
        .select()
        .from(Attachments)
        .where(eq(Attachments.attachmentId, imageUploadId));
      await transaction.insert(AttachmentTurnReservations).values({
        attachmentId: imageUploadId,
        claimToken,
        expiresAt: new Date(Date.now() + 60_000),
      });
      reservationStarted.resolve();
      await finishReservation.promise;
    });
    await reservationStarted.promise;
    const deletion =
      images.deleteUnlinkedUnreservedImageAttachment(imageUploadId);
    // The database queues it behind the open transaction, so it can only
    // run once that transaction commits.
    finishReservation.resolve();
    const [, deletedImageUploadId] = await Promise.all([reservation, deletion]);
    expect(deletedImageUploadId).toBeNull();
    expect(
      await db
        .select()
        .from(Attachments)
        .where(eq(Attachments.attachmentId, imageUploadId)),
    ).toHaveLength(1);
  });
});
