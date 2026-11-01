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
    transcriptModelId: "nova-3-general",
  };
}

async function createJob() {
  const job = youtubeJob();
  await jobs.createAudioJob(job);
  return job.audioUploadId;
}

/**
 * A YouTube job for the video, taken through to completed with `text`, made
 * by `transcriptModelId` (null: the video's captions).
 */
async function transcribeVideo(
  text: string,
  transcriptModelId: string | null = "nova-3-general",
) {
  const audioUploadId = await createJob();
  const claimed = await jobs.claimAudioJob(audioUploadId);
  await transcripts.saveCompletedTranscript(
    audioUploadId,
    [{ start: 0, end: 2, text }],
    transcriptModelId,
    claimed!.claimToken,
  );
  return audioUploadId;
}

/** What a request with captions off and the default model would reuse. */
const nova3 = {
  transcriptModelId: "nova-3-general",
  useCaptionsIfAvailable: false,
};
const nova3OrCaptions = { ...nova3, useCaptionsIfAvailable: true };

async function readJob(audioUploadId: string) {
  const [row] = await db
    .select({
      status: AudioTranscriptionJobs.status,
      claimToken: AudioTranscriptionJobs.claimToken,
      error: AudioTranscriptionJobs.error,
      transcriptModelId: AudioTranscriptionJobs.transcriptModelId,
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

      expect(await transcripts.findYoutubeTranscript(videoId, nova3)).toEqual({
        transcriptModelId: "nova-3-general",
        content: expect.stringContaining("Never gonna give you up"),
        segments: [{ start: 0, end: 2, text: "Never gonna give you up" }],
        charCount: expect.any(Number),
      });
    });

    it("finds nothing for a video no job has finished", async () => {
      const audioUploadId = await createJob();
      await jobs.claimAudioJob(audioUploadId);

      expect(
        await transcripts.findYoutubeTranscript(videoId, nova3),
      ).toBeNull();
      expect(
        await transcripts.findYoutubeTranscript("aaaaaaaaaaa", nova3),
      ).toBeNull();
    });

    it("finds nothing made by another model", async () => {
      await transcribeVideo("Never gonna give you up", "nova-2-general");

      expect(
        await transcripts.findYoutubeTranscript(videoId, nova3),
      ).toBeNull();
      expect(
        await transcripts.findYoutubeTranscript(videoId, nova3OrCaptions),
      ).toBeNull();
    });

    it("finds captions only for a request that takes them", async () => {
      await transcribeVideo("Never gonna give you up", null);

      expect(
        await transcripts.findYoutubeTranscript(videoId, nova3),
      ).toBeNull();
      expect(
        await transcripts.findYoutubeTranscript(videoId, nova3OrCaptions),
      ).toMatchObject({ transcriptModelId: null });
    });

    it("finds the model's transcript for a request that takes captions", async () => {
      await transcribeVideo("Never gonna give you up");

      expect(
        await transcripts.findYoutubeTranscript(videoId, nova3OrCaptions),
      ).toMatchObject({ transcriptModelId: "nova-3-general" });
    });

    it("records what made a transcript on its job", async () => {
      const transcribed = await transcribeVideo("Never gonna give you up");
      const captioned = await transcribeVideo("Never gonna give you up", null);

      expect(await readJob(transcribed)).toMatchObject({
        transcriptModelId: "nova-3-general",
      });
      expect(await readJob(captioned)).toMatchObject({
        transcriptModelId: null,
      });
    });

    it("gives another user a completed job of their own with a copy", async () => {
      await transcribeVideo("Never gonna give you up", null);
      const found = await transcripts.findYoutubeTranscript(
        videoId,
        nova3OrCaptions,
      );
      const job = youtubeJob(otherUserId);

      await transcripts.createReusedYoutubeJob(job, found!);

      // Made by what made the original, not by the model the request named.
      expect(await readJob(job.audioUploadId)).toMatchObject({
        status: "completed",
        claimToken: null,
        transcriptModelId: null,
      });
      const theirs = await transcripts.findTranscripts(otherUserId, [
        job.audioUploadId,
      ]);
      expect(theirs.get(job.audioUploadId)).toBe(found!.content);
    });

    it("keeps the copy when the original's owner deletes theirs", async () => {
      const original = await transcribeVideo("Never gonna give you up");
      const job = youtubeJob(otherUserId);
      await transcripts.createReusedYoutubeJob(
        job,
        (await transcripts.findYoutubeTranscript(videoId, nova3))!,
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
        await transcripts.findYoutubeTranscript(videoId, nova3),
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
      await jobs.completeAudioJob(
        audioUploadId,
        claimed!.claimToken,
        "nova-3-general",
      );

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
      await jobs.completeAudioJob(
        audioUploadId,
        claimed!.claimToken,
        "nova-3-general",
      );

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
