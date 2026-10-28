import type { Job, JobsPage } from "@parley/contract";
import { authed } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import {
  jobCursorSchema,
  jobReqParamSchema,
  jobsListQuerySchema,
} from "../schema/jobs.schema";
import { encodeCursor, decodeCursor } from "@parley/server-kit/http/cursor";
import { uploads } from "../uploads";
import { data } from "../data";
import { tryCatch } from "@parley/server-kit/runtime/try-catch";
import { logger } from "@parley/server-kit/runtime/logger";

const log = logger.child({ controller: "jobs" });

export const handleGetTranscribeJob = authed.createHandlers(
  validate("param", jobReqParamSchema),
  async (c) => {
    const { userId } = c.var;
    const { audioUploadId } = c.req.valid("param");

    // A transcript row exists only for a completed job, so its presence is enough
    // without a separate status check.
    // A transcript-read failure degrades to null rather than failing the job view.
    const [audioJob, transcriptResult] = await Promise.all([
      data.jobs.findAudioJob(userId, audioUploadId),
      tryCatch(data.transcripts.findTranscripts(userId, [audioUploadId])),
    ]);

    if (!audioJob) return c.json({ message: "Job not found" }, 404);

    if (transcriptResult.error)
      log.error(
        "Failed to read transcript for job view",
        transcriptResult.error,
        {
          audioUploadId,
        },
      );

    return c.json({
      audioUploadId: audioJob.audioUploadId,
      fileName: audioJob.fileName,
      source: audioJob.source,
      status: audioJob.status,
      transcript: transcriptResult.data?.get(audioUploadId) ?? null,
      error: audioJob.error,
    } satisfies Job);
  },
);

const DEFAULT_PAGE_SIZE = 20;

export const handleListJobs = authed.createHandlers(
  validate("query", jobsListQuerySchema),
  async (c) => {
    const { userId } = c.var;
    const {
      limit = DEFAULT_PAGE_SIZE,
      cursor: rawCursor,
      status,
      q: searchQuery,
    } = c.req.valid("query");

    // A malformed/forged cursor decodes to null → fall back to the first page.
    const cursor = rawCursor ? decodeCursor(rawCursor, jobCursorSchema) : null;

    const rows = await data.jobs.findUserJobsPage({
      userId,
      status,
      searchQuery,
      cursor,
      // Over-fetch one so we can tell whether another page exists.
      fetchCount: limit + 1,
    });

    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({
            createdAt: last.createdAt,
            audioUploadId: last.audioUploadId,
          })
        : null;

    return c.json({
      jobs: page.map((job) => ({
        ...job,
        createdAt: job.createdAt.toISOString(),
      })),
      nextCursor,
    } satisfies JobsPage);
  },
);

export const handleDeleteTranscribeJob = authed.createHandlers(
  validate("param", jobReqParamSchema),
  async (c) => {
    const { userId } = c.var;
    const { audioUploadId } = c.req.valid("param");

    const job = await data.jobs.findAudioJob(userId, audioUploadId);
    if (!job) return c.json({ message: "Job Deleted" }, 200);

    const deleted = await data.jobs.deleteAudioJob(userId, audioUploadId);
    if (!deleted) {
      return c.json(
        { message: "Source is linked to a message or reserved for a response" },
        409,
      );
    }

    // Deleting an unfinished youtube job doesn't stop its fetch: the fetcher is
    // another process taking work off a queue. Removing the objects now would
    // drop its ledger record before the fetch writes the audio, leaving a file
    // nothing knows about. The record stays marked deleted instead, and the
    // sweep removes whatever landed once the fetch is long over.
    if (!deleted.fetchMayStillWrite) {
      await uploads.deleteObjects(userId, [
        { kind: "audio", uploadId: audioUploadId },
      ]);
    }
    return c.json({ message: "Job Deleted" }, 200);
  },
);
