import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
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
  schemaName: `ledger_test_${Date.now()}`,
  client: null as Sql | null,
  deleteFromBucket: vi.fn(),
}));

vi.mock("../../src/storage/bucket", () => ({
  bucket: {
    delete: testState.deleteFromBucket,
  },
}));

vi.mock("../../src/storage/sign", () => ({
  IMAGE_URL_TTL_SECONDS: 604800,
  sign: {
    urls: vi.fn(),
  },
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

import {
  Attachments,
  AudioTranscriptionJobs,
  StorageLedger,
  db,
  users,
  type Executor,
} from "../../src/db";
import { attachments } from "../../src/data/attachments.data";
import { jobs } from "../../src/data/jobs.data";
import { images } from "../../src/data/images.data";
import { sweeper } from "../../src/sweeper";
import { uploads } from "../../src/uploads";
import { storageLedger } from "../../src/data/storageLedger.data";
import { advisoryLock } from "../../src/data/advisoryLock.data";

const userId = "ledger-owner";
const HOUR_MS = 60 * 60 * 1000;
const image = () => ({
  userId,
  kind: "image" as const,
  uploadId: randomUUID(),
});

async function ledger() {
  return db
    .select({
      uploadId: StorageLedger.uploadId,
      kind: StorageLedger.kind,
      status: StorageLedger.status,
    })
    .from(StorageLedger)
    .orderBy(StorageLedger.createdAt);
}

async function backdate(uploadId: string, msAgo: number) {
  await db.execute(sql`
    update ${StorageLedger}
    set created_at = now() - make_interval(secs => ${msAgo / 1000})
    where upload_id = ${uploadId}
  `);
}

function insertAttachment(uploadId: string) {
  return async (executor: Executor) => {
    await executor.insert(Attachments).values({
      attachmentId: uploadId,
      kind: "image",
      userId,
      fileName: "a.png",
      sizeBytes: 1,
    });
  };
}

// ATTACHMENT_TEST_DATABASE_URL enables these tests; each run creates and drops its own schema.
describe.skipIf(!testState.databaseUrl)("storage ledger in PostgreSQL", () => {
  beforeAll(async () => {
    await db.execute(sql.raw(`create schema "${testState.schemaName}"`));
    const schemaSql = exportSchemaSql().replaceAll(
      '"public"',
      `"${testState.schemaName}"`,
    );
    await testState.client!.unsafe(schemaSql);
  });

  afterAll(async () => {
    await db.execute(sql.raw(`drop schema "${testState.schemaName}" cascade`));
    await testState.client!.end();
  });

  beforeEach(async () => {
    testState.deleteFromBucket.mockReset().mockResolvedValue([]);
    await db.execute(sql`truncate ${users}, ${StorageLedger} cascade`);
    await db.insert(users).values({ id: userId });
  });

  describe("recording", () => {
    it("finds an entry only under its own owner and kind", async () => {
      const upload = image();
      await storageLedger.recordPendingUpload(upload);

      expect(await storageLedger.findLedgerEntry(upload)).toEqual({
        status: "pending",
        createdAt: expect.any(Date),
      });
      expect(
        await storageLedger.findLedgerEntry({
          ...upload,
          userId: "someone-else",
        }),
      ).toBeUndefined();
      expect(
        await storageLedger.findLedgerEntry({ ...upload, kind: "audio" }),
      ).toBeUndefined();
    });

    it("records objects that start out referenced", async () => {
      const audio = randomUUID();
      const picture = randomUUID();

      await storageLedger.recordConfirmedObjects(userId, [
        { kind: "audio", uploadId: audio },
        { kind: "image", uploadId: picture },
      ]);

      expect(await ledger()).toEqual(
        expect.arrayContaining([
          { uploadId: audio, kind: "audio", status: "confirmed" },
          { uploadId: picture, kind: "image", status: "confirmed" },
        ]),
      );
    });
  });

  describe("confirmUpload", () => {
    it("confirms once, writing the referencing row in the same transaction", async () => {
      const upload = image();
      await storageLedger.recordPendingUpload(upload);

      expect(
        await storageLedger.confirmUpload(
          upload,
          HOUR_MS,
          insertAttachment(upload.uploadId),
        ),
      ).toBe(true);
      expect((await storageLedger.findLedgerEntry(upload))?.status).toBe(
        "confirmed",
      );
      expect(await db.select().from(Attachments)).toHaveLength(1);

      const again = vi.fn();
      expect(await storageLedger.confirmUpload(upload, HOUR_MS, again)).toBe(
        false,
      );
      expect(again).not.toHaveBeenCalled();
    });

    // The real writes, each running its own transaction inside the confirm's.
    it("confirms through jobs.createAudioJob and createImageAttachment", async () => {
      const audio = { userId, kind: "audio" as const, uploadId: randomUUID() };
      const picture = image();
      await storageLedger.recordPendingUpload(audio);
      await storageLedger.recordPendingUpload(picture);

      expect(
        await storageLedger.confirmUpload(audio, HOUR_MS, (executor) =>
          jobs.createAudioJob(
            {
              audioUploadId: audio.uploadId as never,
              userId,
              source: "audio",
              fileName: "a.webm",
              mimeType: "audio/webm",
              sizeBytes: 1,
            },
            executor,
          ),
        ),
      ).toBe(true);
      expect(
        await storageLedger.confirmUpload(picture, HOUR_MS, (executor) =>
          images.createImageAttachment(
            {
              userId,
              imageUploadId: picture.uploadId as never,
              fileName: "a.png",
              mimeType: "image/png",
              sizeBytes: 1,
              signedUrl: "https://signed",
            },
            executor,
          ),
        ),
      ).toBe(true);

      expect((await ledger()).map((row) => row.status)).toEqual([
        "confirmed",
        "confirmed",
      ]);
      expect(
        (await db.select().from(Attachments)).map((row) => row.kind).sort(),
      ).toEqual(["audio", "image"]);
    });

    it("stays pending when the job row fails after its attachment row", async () => {
      const audio = { userId, kind: "audio" as const, uploadId: randomUUID() };
      await storageLedger.recordPendingUpload(audio);

      await expect(
        storageLedger.confirmUpload(audio, HOUR_MS, (executor) =>
          jobs.createAudioJob(
            {
              audioUploadId: audio.uploadId as never,
              userId,
              // The job row requires a source.
              source: null as never,
              fileName: "a.webm",
              mimeType: "audio/webm",
              sizeBytes: 1,
            },
            executor,
          ),
        ),
      ).rejects.toThrow();

      expect((await storageLedger.findLedgerEntry(audio))?.status).toBe(
        "pending",
      );
      expect(await db.select().from(Attachments)).toEqual([]);
    });

    it("refuses an upload recorded before the window", async () => {
      const upload = image();
      await storageLedger.recordPendingUpload(upload);
      await backdate(upload.uploadId, HOUR_MS + 1000);

      const write = vi.fn();
      expect(await storageLedger.confirmUpload(upload, HOUR_MS, write)).toBe(
        false,
      );
      expect(write).not.toHaveBeenCalled();
      expect((await storageLedger.findLedgerEntry(upload))?.status).toBe(
        "pending",
      );
    });

    it("refuses another owner's or another kind's upload", async () => {
      const upload = image();
      await storageLedger.recordPendingUpload(upload);
      const write = vi.fn();

      expect(
        await storageLedger.confirmUpload(
          { ...upload, userId: "x" },
          HOUR_MS,
          write,
        ),
      ).toBe(false);
      expect(
        await storageLedger.confirmUpload(
          { ...upload, kind: "audio" },
          HOUR_MS,
          write,
        ),
      ).toBe(false);
      expect(write).not.toHaveBeenCalled();
    });

    // A deleted object can't be brought back by confirming it again.
    it("refuses an object marked deleted", async () => {
      const upload = image();
      await storageLedger.recordPendingUpload(upload);
      await db.transaction((tx) =>
        storageLedger.markDeleted(userId, [upload], tx),
      );

      expect(await storageLedger.confirmUpload(upload, HOUR_MS, vi.fn())).toBe(
        false,
      );
    });

    it("stays pending when the write fails", async () => {
      const upload = image();
      await storageLedger.recordPendingUpload(upload);

      await expect(
        storageLedger.confirmUpload(upload, HOUR_MS, async () => {
          throw new Error("insert failed");
        }),
      ).rejects.toThrow("insert failed");
      expect((await storageLedger.findLedgerEntry(upload))?.status).toBe(
        "pending",
      );
    });

    it("lets exactly one of two concurrent confirms through", async () => {
      const upload = image();
      await storageLedger.recordPendingUpload(upload);
      const write = vi.fn(async (executor: Executor) => {
        await executor.execute(sql`select pg_sleep(0.2)`);
      });

      const results = await Promise.all([
        storageLedger.confirmUpload(upload, HOUR_MS, write),
        storageLedger.confirmUpload(upload, HOUR_MS, write),
      ]);

      expect(results.sort()).toEqual([false, true]);
      expect(write).toHaveBeenCalledTimes(1);
    });
  });

  describe("deletion", () => {
    it("marks inside the caller's transaction and rolls back with it", async () => {
      const [kept, rolledBack] = [image(), image()];
      await storageLedger.recordConfirmedObjects(userId, [kept, rolledBack]);

      await db.transaction((tx) =>
        storageLedger.markDeleted(userId, [kept], tx),
      );
      await expect(
        db.transaction(async (tx) => {
          await storageLedger.markDeleted(userId, [rolledBack], tx);
          throw new Error("rolled back");
        }),
      ).rejects.toThrow("rolled back");

      expect((await storageLedger.findLedgerEntry(kept))?.status).toBe(
        "deleted",
      );
      expect((await storageLedger.findLedgerEntry(rolledBack))?.status).toBe(
        "confirmed",
      );
    });

    it("marks only the owner's objects", async () => {
      const upload = image();
      await storageLedger.recordConfirmedObjects(userId, [upload]);

      await db.transaction((tx) =>
        storageLedger.markDeleted("someone-else", [upload], tx),
      );

      expect((await storageLedger.findLedgerEntry(upload))?.status).toBe(
        "confirmed",
      );
    });

    it("forgets deleted and pending records, never confirmed ones", async () => {
      const [deleted, pending, confirmed] = [image(), image(), image()];
      await storageLedger.recordConfirmedObjects(userId, [deleted, confirmed]);
      await storageLedger.recordPendingUpload(pending);
      await db.transaction((tx) =>
        storageLedger.markDeleted(userId, [deleted], tx),
      );

      await storageLedger.forgetObjects("someone-else", [deleted, pending]);
      expect(await ledger()).toHaveLength(3);

      await storageLedger.forgetObjects(userId, [deleted, pending, confirmed]);
      expect(await ledger()).toEqual([
        { uploadId: confirmed.uploadId, kind: "image", status: "confirmed" },
      ]);
    });
  });

  describe("deletes mark what they leave behind", () => {
    async function addImage() {
      const uploadId = randomUUID();
      await db.insert(Attachments).values({
        attachmentId: uploadId,
        kind: "image",
        userId,
        fileName: "a.png",
        sizeBytes: 1,
      });
      await storageLedger.recordConfirmedObjects(userId, [
        { kind: "image", uploadId },
      ]);
      return uploadId;
    }

    async function addJob() {
      const audioUploadId = randomUUID();
      await jobs.createAudioJob({
        audioUploadId: audioUploadId as never,
        userId,
        source: "youtube",
        fileName: "yt",
        mimeType: null,
        sizeBytes: 0,
      });
      await storageLedger.recordConfirmedObjects(userId, [
        { kind: "audio", uploadId: audioUploadId },
      ]);
      await db
        .update(AudioTranscriptionJobs)
        .set({ status: "completed" })
        .where(sql`${AudioTranscriptionJobs.audioUploadId} = ${audioUploadId}`);
      return audioUploadId;
    }

    const statusOf = async (uploadId: string) =>
      (await ledger()).find((row) => row.uploadId === uploadId)?.status;

    it("marks deleted attachments, and only those", async () => {
      const [a, b] = [await addImage(), await addImage()];

      const deleted =
        await attachments.deleteOwnedUnlinkedUnreservedAttachments({
          userId,
          attachmentIds: [a, randomUUID()],
          kind: "image",
        });

      expect(deleted).toEqual([a]);
      expect(await statusOf(a)).toBe("deleted");
      expect(await statusOf(b)).toBe("confirmed");
    });

    it("marks nothing when another user's attachment isn't deleted", async () => {
      const a = await addImage();

      await attachments.deleteOwnedUnlinkedUnreservedAttachments({
        userId: "someone-else",
        attachmentIds: [a],
        kind: "image",
      });

      expect(await statusOf(a)).toBe("confirmed");
    });

    it.each([
      ["queued", true],
      ["processing", true],
      ["completed", false],
      ["failed", false],
    ])(
      "reports whether a %s youtube fetch could still write",
      async (status, fetchMayStillWrite) => {
        const audioUploadId = await addJob();
        await db
          .update(AudioTranscriptionJobs)
          .set({ status: status as "queued" })
          .where(
            sql`${AudioTranscriptionJobs.audioUploadId} = ${audioUploadId}`,
          );

        expect(await jobs.deleteAudioJob(userId, audioUploadId)).toMatchObject({
          fetchMayStillWrite,
        });
      },
    );

    // Nothing writes a direct upload's objects after it exists.
    it("reports that a queued direct upload's objects are settled", async () => {
      const audioUploadId = randomUUID();
      await jobs.createAudioJob({
        audioUploadId: audioUploadId as never,
        userId,
        source: "audio",
        fileName: "clip.webm",
        mimeType: "audio/webm",
        sizeBytes: 1,
      });
      await storageLedger.recordConfirmedObjects(userId, [
        { kind: "audio", uploadId: audioUploadId },
      ]);

      expect(await jobs.deleteAudioJob(userId, audioUploadId)).toMatchObject({
        fetchMayStillWrite: false,
      });
    });

    it("marks a deleted job's audio", async () => {
      const audioUploadId = await addJob();

      expect(await jobs.deleteAudioJob(userId, audioUploadId)).not.toBeNull();
      expect(await statusOf(audioUploadId)).toBe("deleted");
    });

    it("marks nothing for a job that isn't the caller's", async () => {
      const audioUploadId = await addJob();

      expect(
        await jobs.deleteAudioJob("someone-else", audioUploadId),
      ).toBeNull();
      expect(await statusOf(audioUploadId)).toBe("confirmed");
    });

    it("marks a deleted image for removal and drops the record once storage deletes it", async () => {
      const a = await addImage();

      expect(
        await images.deleteOwnedUnlinkedUnreservedImageAttachment(userId, a),
      ).toBe(a);
      expect(await statusOf(a)).toBe("deleted");
      expect(await db.select().from(Attachments)).toEqual([]);

      await uploads.deleteObjects(userId, [{ kind: "image", uploadId: a }]);

      expect(testState.deleteFromBucket).toHaveBeenCalledWith(userId, [
        { kind: "image", uploadId: a },
      ]);
      expect(await statusOf(a)).toBeUndefined();
    });

    // The row is already gone, so a failed storage delete leaves the mark for
    // the sweep instead of a retry.
    it("leaves the image marked deleted when its storage delete fails", async () => {
      const a = await addImage();
      await images.deleteOwnedUnlinkedUnreservedImageAttachment(userId, a);
      testState.deleteFromBucket.mockRejectedValueOnce(new Error("down"));

      await expect(
        uploads.deleteObjects(userId, [{ kind: "image", uploadId: a }]),
      ).rejects.toThrow("down");

      expect(await statusOf(a)).toBe("deleted");
      expect(await db.select().from(Attachments)).toEqual([]);
    });
  });

  describe("createYoutubeAudioJob", () => {
    const youtubeJob = () => ({
      audioUploadId: randomUUID() as never,
      userId,
      source: "youtube" as const,
      youtubeSourceUrl: "https://youtu.be/x",
      fileName: "YouTube audio",
      mimeType: null,
      sizeBytes: 0,
    });

    it("records the job's audio as referenced", async () => {
      const job = youtubeJob();

      await jobs.createYoutubeAudioJob(job);

      expect(await ledger()).toEqual([
        { uploadId: job.audioUploadId, kind: "audio", status: "confirmed" },
      ]);
      expect(await db.select().from(AudioTranscriptionJobs)).toHaveLength(1);
    });

    it("records nothing when the job can't be created", async () => {
      const job = { ...youtubeJob(), userId: "no-such-user" };

      await expect(jobs.createYoutubeAudioJob(job)).rejects.toThrow();

      expect(await ledger()).toEqual([]);
    });
  });

  describe("findLedgerEntries", () => {
    it("finds the asked-for statuses before the cutoff, oldest first, up to the limit", async () => {
      const [oldPending, freshPending, oldDeleted, oldConfirmed] = [
        image(),
        image(),
        image(),
        image(),
      ];
      await storageLedger.recordPendingUpload(oldPending);
      await storageLedger.recordPendingUpload(freshPending);
      await storageLedger.recordConfirmedObjects(userId, [
        oldDeleted,
        oldConfirmed,
      ]);
      await db.transaction((tx) =>
        storageLedger.markDeleted(userId, [oldDeleted], tx),
      );
      await backdate(oldPending.uploadId, 5 * HOUR_MS);
      await backdate(oldDeleted.uploadId, 4 * HOUR_MS);
      await backdate(oldConfirmed.uploadId, 6 * HOUR_MS);
      await backdate(freshPending.uploadId, 2 * HOUR_MS);

      const createdBefore = new Date(Date.now() - 3 * HOUR_MS);
      const strip = ({ userId: owner, kind, uploadId }: typeof oldPending) => ({
        userId: owner,
        kind,
        uploadId,
      });

      const statuses = ["pending", "deleted"] as const;
      expect(
        await storageLedger.findLedgerEntries({
          statuses,
          createdBefore,
          limit: 10,
        }),
      ).toEqual([strip(oldPending), strip(oldDeleted)]);
      expect(
        await storageLedger.findLedgerEntries({
          statuses,
          createdBefore,
          limit: 1,
        }),
      ).toEqual([strip(oldPending)]);
      expect(
        await storageLedger.findLedgerEntries({
          statuses: ["confirmed"],
          createdBefore,
          limit: 10,
        }),
      ).toEqual([strip(oldConfirmed)]);
    });
  });

  describe("sweepUnusedObjects", () => {
    it("removes what nothing uses once it's past its grace, and nothing else", async () => {
      const [stalePending, freshPending, staleDeleted, staleConfirmed] = [
        image(),
        image(),
        image(),
        image(),
      ];
      const failing = {
        userId: "other-owner",
        kind: "audio" as const,
        uploadId: randomUUID(),
      };
      await storageLedger.recordPendingUpload(stalePending);
      await storageLedger.recordPendingUpload(freshPending);
      await storageLedger.recordConfirmedObjects(userId, [
        staleDeleted,
        staleConfirmed,
      ]);
      await storageLedger.recordPendingUpload(failing);
      await db.transaction((tx) =>
        storageLedger.markDeleted(userId, [staleDeleted], tx),
      );
      for (const { uploadId } of [
        stalePending,
        staleDeleted,
        staleConfirmed,
        failing,
      ]) {
        await backdate(uploadId, 4 * HOUR_MS);
      }
      // Two hours old: inside the three-hour grace.
      await backdate(freshPending.uploadId, 2 * HOUR_MS);
      testState.deleteFromBucket.mockImplementation(async (owner: string) => {
        if (owner === "other-owner") throw new Error("storage down");
        return [];
      });

      expect(await sweeper.sweepUnusedObjects()).toBe(2);

      expect(testState.deleteFromBucket).toHaveBeenCalledWith(userId, [
        { kind: "image", uploadId: stalePending.uploadId },
        { kind: "image", uploadId: staleDeleted.uploadId },
      ]);
      expect((await ledger()).map((row) => row.uploadId).sort()).toEqual(
        [
          freshPending.uploadId,
          staleConfirmed.uploadId,
          failing.uploadId,
        ].sort(),
      );
    });
  });

  describe("withAdvisoryLock", () => {
    it("refuses a second holder while one runs, and allows one after", async () => {
      let release!: () => void;
      let started!: () => void;
      const running = new Promise<void>((resolve) => (started = resolve));
      const first = advisoryLock.withAdvisoryLock(
        "test-lock",
        () =>
          new Promise<string>((resolve) => {
            release = () => resolve("first");
            started();
          }),
      );
      await running;

      expect(
        await advisoryLock.withAdvisoryLock("test-lock", async () => "second"),
      ).toBeUndefined();
      // A different name is a different lock.
      expect(
        await advisoryLock.withAdvisoryLock("other-lock", async () => "other"),
      ).toBe("other");

      release();
      expect(await first).toBe("first");
      expect(
        await advisoryLock.withAdvisoryLock("test-lock", async () => "third"),
      ).toBe("third");
    });
  });
});
