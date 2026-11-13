import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
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
  schemaName: `attachment_test_${Date.now()}`,
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
      connection: {
        search_path: testState.schemaName,
        application_name: testState.schemaName,
      },
      onnotice: () => {},
    },
  );
  testState.client = client;
  return { ...schema, db: drizzle(client, { schema }) };
});

vi.mock("../../src/storage/bucket", () => ({}));

vi.mock("../../src/storage/sign", () => ({
  IMAGE_URL_TTL_SECONDS: 604800,
  urls: vi.fn(),
}));

import {
  AttachmentTurnReservations,
  Attachments,
  ChatMessageAttachmentLinks,
  Conversations,
  db,
  users,
} from "../../src/db";
import * as attachments from "../../src/data/attachments.data";
import * as images from "../../src/data/images.data";
import * as messages from "../../src/data/messages.data";

const userId = "reservation-owner";
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

async function waitForBlockedQuery() {
  await vi.waitFor(async () => {
    const blocked = await db.execute(sql`
      select 1 from pg_stat_activity
      where application_name = ${testState.schemaName} and wait_event_type = 'Lock'
    `);
    expect(blocked.length).toBeGreaterThan(0);
  });
}

// ATTACHMENT_TEST_DATABASE_URL enables these tests; each run creates and drops its own schema.
describe.skipIf(!testState.databaseUrl)(
  "attachment reservations in PostgreSQL",
  () => {
    beforeAll(async () => {
      await db.execute(sql.raw(`create schema "${testState.schemaName}"`));
      const schemaSql = exportSchemaSql().replaceAll(
        '"public"',
        `"${testState.schemaName}"`,
      );
      await testState.client!.unsafe(schemaSql);
    });

    afterAll(async () => {
      await db.execute(
        sql.raw(`drop schema "${testState.schemaName}" cascade`),
      );
      await testState.client!.end();
    });

    beforeEach(async () => {
      await db.execute(sql`truncate ${users} cascade`);
      await db.insert(users).values({ id: userId });
      await db.insert(Conversations).values({
        id: conversationId,
        userId,
        activeTurnClaimToken: claimToken,
        activeTurnClaimedAt: new Date(),
      });
      await db.insert(Attachments).values([
        {
          attachmentId: imageUploadId,
          userId,
          kind: "image",
          fileName: "image.png",
          sizeBytes: 10,
        },
        {
          attachmentId: audioUploadId,
          userId,
          kind: "audio",
          fileName: "audio.mp3",
          sizeBytes: 20,
        },
      ]);
    });

    it("reserves all requested attachments or none, with ownership checks", async () => {
      expect(
        await attachments.claimAttachments(
          userId,
          [imageUploadId, "missing"],
          claimToken,
        ),
      ).toBe(false);
      expect(
        await attachments.claimAttachments(
          "another-user",
          [imageUploadId],
          claimToken,
        ),
      ).toBe(false);
      expect(await db.select().from(AttachmentTurnReservations)).toEqual([]);
    });

    it("deduplicates IDs and retains the reservation expiry", async () => {
      const startedAt = Date.now();
      expect(
        await attachments.claimAttachments(
          userId,
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
            userId,
            [imageUploadId, audioUploadId],
            randomUUID(),
          ),
          attachments.claimAttachments(
            userId,
            [audioUploadId, imageUploadId],
            randomUUID(),
          ),
        ]),
      ).toEqual([true, true]);
      expect(await db.select().from(AttachmentTurnReservations)).toHaveLength(
        4,
      );
    });

    it("protects images and transcripts until the completed turn links them", async () => {
      expect(
        await attachments.claimAttachments(
          userId,
          [imageUploadId, audioUploadId],
          claimToken,
        ),
      ).toBe(true);
      expect(
        await images.deleteOwnedUnlinkedUnreservedImageAttachment(
          userId,
          imageUploadId,
        ),
      ).toBeNull();
      expect(
        await attachments.deleteOwnedUnlinkedUnreservedAttachments({
          userId,
          attachmentIds: [audioUploadId],
          kind: "audio",
        }),
      ).toEqual([]);

      await messages.persistAndUnclaimChatTurn({
        userId,
        conversationId,
        content: "Summarize",
        attachmentIds: [imageUploadId, audioUploadId],
        chosenModelId: "test-model",
        assistantContent: "Summary",
        contextWindowMessageCount: 2,
        claimToken,
      });
      expect(await db.select().from(ChatMessageAttachmentLinks)).toHaveLength(
        2,
      );
      expect(await db.select().from(AttachmentTurnReservations)).toEqual([]);
      expect(
        await images.deleteOwnedUnlinkedUnreservedImageAttachment(
          userId,
          imageUploadId,
        ),
      ).toBeNull();
    });

    it("releases only the failed turn's reservation when attachments are shared", async () => {
      const otherClaimToken = randomUUID();
      await attachments.claimAttachments(userId, [imageUploadId], claimToken);
      await attachments.claimAttachments(
        userId,
        [imageUploadId],
        otherClaimToken,
      );
      await attachments.unclaimAttachments(claimToken);
      expect(
        await images.deleteOwnedUnlinkedUnreservedImageAttachment(
          userId,
          imageUploadId,
        ),
      ).toBeNull();
      await attachments.unclaimAttachments(otherClaimToken);
      expect(
        await images.deleteOwnedUnlinkedUnreservedImageAttachment(
          userId,
          imageUploadId,
        ),
      ).toBe(imageUploadId);
    });

    it("keeps reservations when persistence rolls back", async () => {
      await attachments.claimAttachments(userId, [imageUploadId], claimToken);
      await db
        .update(Conversations)
        .set({ activeTurnClaimToken: randomUUID() });

      await expect(
        messages.persistAndUnclaimChatTurn({
          userId,
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
      expect(await db.select().from(AttachmentTurnReservations)).toHaveLength(
        1,
      );
      await attachments.unclaimAttachments(claimToken);
      expect(
        await images.deleteOwnedUnlinkedUnreservedImageAttachment(
          userId,
          imageUploadId,
        ),
      ).toBe(imageUploadId);
    });

    it("protects an expired reservation while its conversation claim still exists", async () => {
      await attachments.claimAttachments(userId, [imageUploadId], claimToken);
      await db
        .update(AttachmentTurnReservations)
        .set({ expiresAt: new Date(0) });
      expect(
        await images.deleteOwnedUnlinkedUnreservedImageAttachment(
          userId,
          imageUploadId,
        ),
      ).toBeNull();

      await db.update(Conversations).set({ activeTurnClaimToken: null });
      expect(
        await images.deleteOwnedUnlinkedUnreservedImageAttachment(
          userId,
          imageUploadId,
        ),
      ).toBe(imageUploadId);
    });

    it("waits for an ongoing image deletion and rejects reservation if deletion wins", async () => {
      const deleted = deferred();
      const finishDeletion = deferred();
      const deletion = db.transaction(async (transaction) => {
        await attachments.deleteOwnedUnlinkedUnreservedAttachment(
          { userId, attachmentId: imageUploadId, kind: "image" },
          transaction,
        );
        deleted.resolve();
        await finishDeletion.promise;
      });
      await deleted.promise;
      const reservation = attachments.claimAttachments(
        userId,
        [imageUploadId],
        claimToken,
      );
      try {
        await waitForBlockedQuery();
      } finally {
        finishDeletion.resolve();
      }
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
          .where(
            and(
              eq(Attachments.userId, userId),
              eq(Attachments.attachmentId, imageUploadId),
            ),
          )
          .for("update");
        await transaction.insert(AttachmentTurnReservations).values({
          attachmentId: imageUploadId,
          claimToken,
          expiresAt: new Date(Date.now() + 60_000),
        });
        reservationStarted.resolve();
        await finishReservation.promise;
      });
      await reservationStarted.promise;
      const deletion = images.deleteOwnedUnlinkedUnreservedImageAttachment(
        userId,
        imageUploadId,
      );
      try {
        await waitForBlockedQuery();
      } finally {
        finishReservation.resolve();
      }
      const [, deletedImageUploadId] = await Promise.all([
        reservation,
        deletion,
      ]);
      expect(deletedImageUploadId).toBeNull();
      expect(
        await db
          .select()
          .from(Attachments)
          .where(eq(Attachments.attachmentId, imageUploadId)),
      ).toHaveLength(1);
    });
  },
);
