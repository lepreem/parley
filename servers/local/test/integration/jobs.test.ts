import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/db", async () =>
  (await import("../helpers/inMemoryDb")).inMemoryDbModule(),
);

import { AudioTranscriptionJobs, db } from "../../core/db";
import { deleteAllRows } from "../helpers/inMemoryDb";
import { jobs } from "../../core/data/jobs.data";

async function createJob() {
  const audioUploadId = randomUUID();
  await jobs.createAudioJob({
    audioUploadId,
    source: "youtube",
    fileName: "YouTube audio",
    mimeType: null,
    sizeBytes: 0,
    transcriptModelId: "small",
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

describe("audio jobs", () => {
  beforeEach(async () => {
    await deleteAllRows(db);
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
      expect(await jobs.claimAudioJob(audioUploadId)).not.toBeNull();
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

      await jobs.failAudioJob(
        audioUploadId,
        claimed!.claimToken,
        "Could not be transcribed",
      );

      expect(await readJob(audioUploadId)).toMatchObject({
        status: "failed",
        error: "Could not be transcribed",
      });
    });

    it("leaves another worker's claim alone", async () => {
      const audioUploadId = await createJob();
      await jobs.claimAudioJob(audioUploadId);

      await jobs.failAudioJob(
        audioUploadId,
        randomUUID(),
        "Could not be transcribed",
      );

      expect(await readJob(audioUploadId)).toMatchObject({
        status: "processing",
        error: null,
      });
    });
  });
  describe("requeueUnfinishedAudioJobs", () => {
    it("puts jobs a stopped process left processing back to queued, unclaimed", async () => {
      const audioUploadId = await createJob();
      await jobs.claimAudioJob(audioUploadId);

      await jobs.requeueUnfinishedAudioJobs();

      expect(await readJob(audioUploadId)).toMatchObject({
        status: "queued",
        claimToken: null,
      });
    });

    it("returns every unfinished job with what it takes to queue it again", async () => {
      const youtubeJob = randomUUID();
      await jobs.createAudioJob({
        audioUploadId: youtubeJob,
        source: "youtube",
        fileName: "YouTube audio",
        mimeType: null,
        sizeBytes: 0,
        transcriptModelId: "small",
        youtubeSourceUrl: "https://www.youtube.com/watch?v=abc",
        useCaptionsIfAvailable: true,
      });
      const uploadedJob = randomUUID();
      await jobs.createAudioJob({
        audioUploadId: uploadedJob,
        source: "audio",
        fileName: "talk.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 10,
        transcriptModelId: "small",
      });
      await jobs.claimAudioJob(uploadedJob);

      const unfinished = await jobs.requeueUnfinishedAudioJobs();

      expect(
        unfinished.sort((a, b) => a.source.localeCompare(b.source)),
      ).toEqual([
        {
          audioUploadId: uploadedJob,
          source: "audio",
          youtubeSourceUrl: null,
          useCaptionsIfAvailable: null,
        },
        {
          audioUploadId: youtubeJob,
          source: "youtube",
          youtubeSourceUrl: "https://www.youtube.com/watch?v=abc",
          useCaptionsIfAvailable: true,
        },
      ]);
    });

    it("leaves finished jobs alone", async () => {
      const completed = await createJob();
      const claimed = await jobs.claimAudioJob(completed);
      await jobs.completeAudioJob(completed, claimed!.claimToken);
      const failed = await createJob();
      await jobs.failAudioJobById(failed, "fetch failed");

      expect(await jobs.requeueUnfinishedAudioJobs()).toEqual([]);
      expect((await readJob(completed)).status).toBe("completed");
      expect((await readJob(failed)).status).toBe("failed");
    });
  });
});
