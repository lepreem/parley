import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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
  schemaName: `jobs_test_${Date.now()}`,
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

import { AudioTranscriptionJobs, db, users } from "../../src/db";
import { jobs } from "../../src/data/jobs.data";

const userId = "jobs-owner";

async function createJob() {
  const audioUploadId = randomUUID();
  await jobs.createAudioJob({
    audioUploadId,
    userId,
    source: "youtube",
    fileName: "YouTube audio",
    mimeType: null,
    sizeBytes: 0,
  });
  return audioUploadId;
}

async function readJob(audioUploadId: string) {
  const [row] = await db
    .select({
      status: AudioTranscriptionJobs.status,
      claimToken: AudioTranscriptionJobs.claimToken,
      error: AudioTranscriptionJobs.error,
    })
    .from(AudioTranscriptionJobs)
    .where(eq(AudioTranscriptionJobs.audioUploadId, audioUploadId));
  return row;
}

// ATTACHMENT_TEST_DATABASE_URL enables these tests; each run creates and drops its own schema.
describe.skipIf(!testState.databaseUrl)("audio jobs in PostgreSQL", () => {
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
    await db.execute(sql`truncate ${users} cascade`);
    await db.insert(users).values({ id: userId });
  });

  describe("failAudioJobById", () => {
    it("fails a queued job with the reported error", async () => {
      const audioUploadId = await createJob();

      await jobs.failAudioJobById(audioUploadId, "fetch failed");

      expect(await readJob(audioUploadId)).toMatchObject({
        status: "failed",
        error: "fetch failed",
      });
    });

    it("fails a job a worker is processing", async () => {
      const audioUploadId = await createJob();
      await jobs.claimAudioJob(audioUploadId);

      await jobs.failAudioJobById(audioUploadId, "fetch failed");

      expect(await readJob(audioUploadId)).toMatchObject({ status: "failed" });
    });

    it("leaves a completed job completed", async () => {
      const audioUploadId = await createJob();
      const claimed = await jobs.claimAudioJob(audioUploadId);
      await jobs.completeAudioJob(audioUploadId, claimed!.claimToken);

      await jobs.failAudioJobById(audioUploadId, "late fetch failure");

      expect(await readJob(audioUploadId)).toMatchObject({
        status: "completed",
        error: null,
      });
    });
  });

  describe("unclaimAndResetAudioJob", () => {
    it("hands the job back as queued with no claim, for a fresh delivery to claim", async () => {
      const audioUploadId = await createJob();
      const claimed = await jobs.claimAudioJob(audioUploadId);

      const unclaimed = await jobs.unclaimAndResetAudioJob(
        audioUploadId,
        claimed!.claimToken,
      );

      expect(unclaimed).toBe(true);
      expect(await readJob(audioUploadId)).toMatchObject({
        status: "queued",
        claimToken: null,
      });
      // Not a redelivery: only a queued job can be claimed this way.
      expect(await jobs.claimAudioJob(audioUploadId, false)).not.toBeNull();
    });

    it("leaves another worker's claim alone", async () => {
      const audioUploadId = await createJob();
      const claimed = await jobs.claimAudioJob(audioUploadId);

      const unclaimed = await jobs.unclaimAndResetAudioJob(
        audioUploadId,
        randomUUID(),
      );

      expect(unclaimed).toBe(false);
      expect(await readJob(audioUploadId)).toMatchObject({
        status: "processing",
        claimToken: claimed!.claimToken,
      });
    });

    it("leaves a completed job completed", async () => {
      const audioUploadId = await createJob();
      const claimed = await jobs.claimAudioJob(audioUploadId);
      await jobs.completeAudioJob(audioUploadId, claimed!.claimToken);

      const unclaimed = await jobs.unclaimAndResetAudioJob(
        audioUploadId,
        claimed!.claimToken,
      );

      expect(unclaimed).toBe(false);
      expect(await readJob(audioUploadId)).toMatchObject({
        status: "completed",
      });
    });
  });

  describe("failAudioJob", () => {
    it("fails the job it holds, with the reason for the user", async () => {
      const audioUploadId = await createJob();
      const claimed = await jobs.claimAudioJob(audioUploadId);

      expect(
        await jobs.failAudioJob(
          audioUploadId,
          claimed!.claimToken,
          "Could not be transcribed",
        ),
      ).toBe(true);

      expect(await readJob(audioUploadId)).toMatchObject({
        status: "failed",
        error: "Could not be transcribed",
      });
    });

    it("leaves another worker's claim alone", async () => {
      const audioUploadId = await createJob();
      await jobs.claimAudioJob(audioUploadId);

      expect(
        await jobs.failAudioJob(
          audioUploadId,
          randomUUID(),
          "Could not be transcribed",
        ),
      ).toBe(false);

      expect(await readJob(audioUploadId)).toMatchObject({
        status: "processing",
        error: null,
      });
    });
  });
});
