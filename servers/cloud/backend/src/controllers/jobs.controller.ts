import type { Job, JobAudio, JobsPage } from "@parley/contract";
import { authed } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import {
  jobCursorSchema,
  jobReqParamSchema,
  jobsListQuerySchema,
} from "../schema/jobs.schema";
import { encodeCursor, decodeCursor } from "@parley/server-kit/http/cursor";
import { uploads } from "../uploads/uploads";
import { sign } from "../storage";
import { data } from "../data";
import { tryCatch } from "@parley/server-kit/runtime/try-catch";
import { logger } from "@parley/server-kit/runtime/logger";
import { jobCancellation } from "@parley/server-kit/transcription/jobCancellation";
import type { UploadId } from "@parley/server-kit/ids";
import { mq } from "../message-queue/messageQueue";

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
      youtubeVideoId: audioJob.youtubeVideoId,
    } satisfies Job);
  },
);

/**
 * GET /jobs/transcribe/:audioUploadId/audio — a link to play the job's audio
 * from, while it's still stored. The ledger says whether it is: the sweep
 * marks a finished job's audio deleted once it's no longer kept.
 */
export const handleGetTranscribeJobAudio = authed.createHandlers(
  validate("param", jobReqParamSchema),
  async (c) => {
    const { userId } = c.var;
    const { audioUploadId } = c.req.valid("param");
    const audio = { kind: "audio", uploadId: audioUploadId } as const;

    const [audioJob, entry] = await Promise.all([
      data.jobs.findAudioJob(userId, audioUploadId),
      data.storageLedger.findLedgerEntry({ userId, ...audio }),
    ]);
    if (!audioJob) return c.json({ message: "Job not found" }, 404);

    const url =
      entry?.status === "confirmed"
        ? await sign.urlIfStored(userId, audio)
        : null;
    return c.json({ url } satisfies JobAudio);
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

    jobCancellation.cancel(audioUploadId);

    // The fetcher is another process, so an unfinished youtube job's fetch is
    // told to stop rather than stopped, and may already be past its last
    // check. Removing the objects now would drop its ledger record before the
    // fetch writes the audio, leaving a file nothing knows about. The record
    // stays marked deleted instead, and the sweep removes whatever landed once
    // the fetch is long over.
    if (deleted.fetchMayStillWrite) {
      // The job is already gone, so this can't fail the delete: a fetch that
      // never hears runs to its end, and its transcription finds no job.
      const { error } = await tryCatch(
        mq.publish(mq.queues.YT_CANCEL_FETCH, {
          audioUploadId: audioUploadId as UploadId,
        }),
      );
      if (error)
        log.error("Could not cancel the fetch", error, { audioUploadId });
    } else {
      await uploads.deleteObjects(userId, [
        { kind: "audio", uploadId: audioUploadId },
      ]);
    }
    return c.json({ message: "Job Deleted" }, 200);
  },
);
