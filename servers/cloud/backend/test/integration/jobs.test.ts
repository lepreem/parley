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

import {
  AudioTranscriptionJobs,
  TranscriptContents,
  db,
  users,
} from "../../src/db";
import { jobs } from "../../src/data/jobs.data";
import { transcripts } from "../../src/data/transcripts.data";

const userId = "jobs-owner";
const otherUserId = "jobs-other-owner";
const videoId = "dQw4w9WgXcQ";

function youtubeJob(owner = userId) {
  return {
    audioUploadId: randomUUID(),
    userId: owner,
    source: "youtube" as const,
    youtubeVideoId: videoId,
    fileName: "YouTube audio",
    mimeType: null,
    sizeBytes: 0,
  };
}

async function createJob() {
  const job = youtubeJob();
  await jobs.createAudioJob(job);
  return job.audioUploadId;
}

/**
 * A YouTube job for the video, taken through to completed with `text`: its
 * audio transcribed, unless `fromCaptions`.
 */
async function transcribeVideo(
  text: string,
  { fromCaptions = false, language = "en" as string | null } = {},
) {
  const audioUploadId = await createJob();
  const claimed = await jobs.claimAudioJob(audioUploadId);
  await transcripts.saveCompletedTranscript(
    audioUploadId,
    { segments: [{ start: 0, end: 2, text }], language, fromCaptions },
    claimed!.claimToken,
  );
  return audioUploadId;
}

/** What a request with captions off, and with them on, would reuse. */
const noCaptions = { useCaptionsIfAvailable: false };
const orCaptions = { useCaptionsIfAvailable: true };

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
    await db.insert(users).values([{ id: userId }, { id: otherUserId }]);
  });

  describe("reusing a YouTube transcript", () => {
    it("finds the transcript a completed job made of the video", async () => {
      await transcribeVideo("Never gonna give you up");

      expect(
        await transcripts.findYoutubeTranscript(videoId, noCaptions),
      ).toEqual({
        content: expect.stringContaining("Never gonna give you up"),
        segments: [{ start: 0, end: 2, text: "Never gonna give you up" }],
        language: "en",
        fromCaptions: false,
        charCount: expect.any(Number),
      });
    });

    it("finds nothing for a video no job has finished", async () => {
      const audioUploadId = await createJob();
      await jobs.claimAudioJob(audioUploadId);

      expect(
        await transcripts.findYoutubeTranscript(videoId, orCaptions),
      ).toBeNull();
      expect(
        await transcripts.findYoutubeTranscript("aaaaaaaaaaa", orCaptions),
      ).toBeNull();
    });

    it("finds captions only for a request that takes them", async () => {
      await transcribeVideo("Never gonna give you up", { fromCaptions: true });

      expect(
        await transcripts.findYoutubeTranscript(videoId, noCaptions),
      ).toBeNull();
      expect(
        await transcripts.findYoutubeTranscript(videoId, orCaptions),
      ).toMatchObject({ fromCaptions: true });
    });

    it("finds captions without a language", async () => {
      await transcribeVideo("Never gonna give you up", {
        fromCaptions: true,
        language: null,
      });

      expect(
        await transcripts.findYoutubeTranscript(videoId, orCaptions),
      ).toMatchObject({ fromCaptions: true, language: null });
    });

    it("finds a transcribed one for a request that takes captions", async () => {
      await transcribeVideo("Never gonna give you up");

      expect(
        await transcripts.findYoutubeTranscript(videoId, orCaptions),
      ).toMatchObject({ fromCaptions: false });
    });

    it("gives another user a completed job of their own with a copy", async () => {
      await transcribeVideo("Never gonna give you up", { fromCaptions: true });
      const found = await transcripts.findYoutubeTranscript(
        videoId,
        orCaptions,
      );
      const job = youtubeJob(otherUserId);

      await transcripts.createReusedYoutubeJob(job, found!);

      expect(await readJob(job.audioUploadId)).toMatchObject({
        status: "completed",
        claimToken: null,
      });
      const theirs = await transcripts.findTranscripts(otherUserId, [
        job.audioUploadId,
      ]);
      expect(theirs.get(job.audioUploadId)).toBe(found!.content);
    });

    it("keeps what the copy is: its language, and that it's captions", async () => {
      await transcribeVideo("Guten Morgen", {
        fromCaptions: true,
        language: "de",
      });
      const job = youtubeJob(otherUserId);

      await transcripts.createReusedYoutubeJob(
        job,
        (await transcripts.findYoutubeTranscript(videoId, orCaptions))!,
      );

      const [copy] = await db
        .select({
          language: TranscriptContents.language,
          fromCaptions: TranscriptContents.fromCaptions,
        })
        .from(TranscriptContents)
        .where(eq(TranscriptContents.audioUploadId, job.audioUploadId));
      expect(copy).toEqual({ language: "de", fromCaptions: true });
    });

    it("keeps the copy when the original's owner deletes theirs", async () => {
      const original = await transcribeVideo("Never gonna give you up");
      const job = youtubeJob(otherUserId);
      await transcripts.createReusedYoutubeJob(
        job,
        (await transcripts.findYoutubeTranscript(videoId, noCaptions))!,
      );

      await jobs.deleteAudioJob(userId, original);

      const theirs = await transcripts.findTranscripts(otherUserId, [
        job.audioUploadId,
      ]);
      expect(theirs.get(job.audioUploadId)).toContain(
        "Never gonna give you up",
      );
      // The copy is a transcript of the video too, so it's found in turn.
      expect(
        await transcripts.findYoutubeTranscript(videoId, noCaptions),
      ).not.toBeNull();
    });
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
