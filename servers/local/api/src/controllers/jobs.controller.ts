import type { Context } from "hono";
import type { Job, JobsPage } from "@parley/contract";
import { CTX_KEYS } from "../../../core/keys";
import { jobCursorSchema, type JobStatus } from "../schema/jobs.schema";
import { encodeCursor, decodeCursor } from "@parley/server-kit/http/cursor";
import { files } from "../../../core/files";
import { data } from "../../../core/data";
import { tryCatch } from "@parley/server-kit/runtime/try-catch";
import { logger } from "@parley/server-kit/runtime/logger";

const log = logger.child({ controller: "jobs" });

export async function handleGetTranscribeJob(c: Context) {
  const audioUploadId = c.get(CTX_KEYS.audioUploadId);

  // A transcript row exists only for a completed job, so its presence is enough
  // without a separate status check.
  // A transcript-read failure degrades to null rather than failing the job view.
  const [audioJob, transcriptResult] = await Promise.all([
    data.jobs.findAudioJob(audioUploadId),
    tryCatch(data.transcripts.findTranscripts([audioUploadId])),
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
}

const DEFAULT_PAGE_SIZE = 20;

export async function getJobs(c: Context) {
  const limit: number = c.get("limit") ?? DEFAULT_PAGE_SIZE;
  const rawCursor: string | undefined = c.get(CTX_KEYS.cursor);
  const status: JobStatus | undefined = c.get(CTX_KEYS.status);
  const searchQuery: string | undefined = c.get(CTX_KEYS.q);

  // A malformed/forged cursor decodes to null → fall back to the first page.
  const cursor = rawCursor ? decodeCursor(rawCursor, jobCursorSchema) : null;

  const rows = await data.jobs.findJobsPage({
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
}

export async function handleDeleteTranscribeJob(c: Context) {
  const audioUploadId = c.get(CTX_KEYS.audioUploadId);

  const job = await data.jobs.findAudioJob(audioUploadId);
  if (!job) return c.json({ message: "Job Deleted" }, 200);

  const deleted = await data.jobs.deleteAudioJob(audioUploadId);
  if (!deleted) {
    return c.json(
      { message: "Source is linked to a message or reserved for a response" },
      409,
    );
  }

  // A YouTube fetch still running can write the file after this; the next
  // startup removes it then.
  await files.delete([{ kind: "audio", uploadId: audioUploadId }]);
  return c.json({ message: "Job Deleted" }, 200);
}
