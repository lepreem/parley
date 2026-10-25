import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, like, lt, or } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { Attachments, AudioTranscriptionJobs, db, type Executor } from "../db";
import type { jobStatuses } from "../db";
import type { UploadId } from "@parley/server-kit/ids";
import { attachments } from "./attachments.data";

/**
 * Types are derived from the schema rather than imported from the API's zod
 * layer: `core/` must not depend on a service.
 */
type JobStatus = (typeof jobStatuses)[number];

type AudioJobRow = typeof AudioTranscriptionJobs.$inferSelect;

/* ---------------------------------------------------------------- API reads */

async function findAudioJob(audioUploadId: string) {
  const [row] = await db
    .select({
      audioUploadId: AudioTranscriptionJobs.audioUploadId,
      fileName: Attachments.fileName,
      source: AudioTranscriptionJobs.source,
      youtubeSourceUrl: AudioTranscriptionJobs.YT_sourceUrl,
      status: AudioTranscriptionJobs.status,
      error: AudioTranscriptionJobs.error,
    })
    .from(AudioTranscriptionJobs)
    .innerJoin(
      Attachments,
      eq(Attachments.attachmentId, AudioTranscriptionJobs.audioUploadId),
    )
    .where(eq(AudioTranscriptionJobs.audioUploadId, audioUploadId))
    .limit(1);

  return row ?? null;
}

/* --------------------------------------------------------- API job listing */

type JobCursor = { createdAt: string; audioUploadId: string };

type JobSummary = {
  audioUploadId: string;
  fileName: string;
  source: AudioJobRow["source"];
  status: JobStatus;
  error: string | null;
  createdAt: Date;
};

/** The projection behind JobSummary — the list page needs no more. */
const audioJobColumns = {
  audioUploadId: AudioTranscriptionJobs.audioUploadId,
  fileName: Attachments.fileName,
  source: AudioTranscriptionJobs.source,
  status: AudioTranscriptionJobs.status,
  createdAt: Attachments.createdAt,
  error: AudioTranscriptionJobs.error,
};

/**
 * Keyset predicate: rows strictly "after" the cursor in (createdAt, audioUploadId)
 * DESC order. The cursor's ISO timestamp is as precise as the column, so it
 * compares exactly.
 */
function afterCursor(
  createdAtCol: AnySQLiteColumn,
  audioUploadIdCol: AnySQLiteColumn,
  cursor: JobCursor | null,
) {
  if (!cursor) return undefined;
  const cursorCreatedAt = new Date(cursor.createdAt);
  return or(
    lt(createdAtCol, cursorCreatedAt),
    and(
      eq(createdAtCol, cursorCreatedAt),
      lt(audioUploadIdCol, cursor.audioUploadId),
    ),
  );
}

type JobsPageFilters = {
  status?: JobStatus;
  searchQuery?: string;
  cursor: JobCursor | null;
  fetchCount: number;
};

/**
 * One page of the job history, newest first. Returns whatever `fetchCount`
 * yields — the caller over-fetches to detect a next page, and owns the cursor
 * encoding. The audioUploadId tiebreak in the ordering is what makes the keyset
 * cursor deterministic.
 */
async function findJobsPage(filters: JobsPageFilters): Promise<JobSummary[]> {
  const { status, searchQuery, cursor, fetchCount } = filters;

  return db
    .select(audioJobColumns)
    .from(AudioTranscriptionJobs)
    .innerJoin(
      Attachments,
      eq(Attachments.attachmentId, AudioTranscriptionJobs.audioUploadId),
    )
    .where(
      and(
        eq(Attachments.kind, "audio"),
        status ? eq(AudioTranscriptionJobs.status, status) : undefined,
        searchQuery
          ? // SQLite's like ignores case, as ilike did.
            like(Attachments.fileName, `%${searchQuery}%`)
          : undefined,
        afterCursor(
          Attachments.createdAt,
          AudioTranscriptionJobs.audioUploadId,
          cursor,
        ),
      ),
    )
    .orderBy(
      desc(Attachments.createdAt),
      desc(AudioTranscriptionJobs.audioUploadId),
    )
    .limit(fetchCount);
}

/* --------------------------------------------------------------- API writes */

/** The attachment row and the job row, together. */
async function createAudioJob(job: {
  audioUploadId: UploadId;
  source: AudioJobRow["source"];
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  transcriptModelId: string;
  youtubeSourceUrl?: string;
  useCaptionsIfAvailable?: boolean;
}) {
  const {
    audioUploadId,
    source,
    fileName,
    mimeType,
    sizeBytes,
    transcriptModelId,
    youtubeSourceUrl,
    useCaptionsIfAvailable,
  } = job;

  await db.transaction(async (tx) => {
    await attachments.createAttachment(
      {
        attachmentId: audioUploadId,
        kind: "audio",
        fileName,
        mimeType,
        sizeBytes,
      },
      tx,
    );
    await tx.insert(AudioTranscriptionJobs).values({
      audioUploadId,
      source,
      transcriptModelId,
      ...(youtubeSourceUrl !== undefined
        ? { YT_sourceUrl: youtubeSourceUrl }
        : {}),
      ...(useCaptionsIfAvailable !== undefined
        ? { YT_useCaptionsIfAvailable: useCaptionsIfAvailable }
        : {}),
    });
  });
}

/**
 * Deletes a job's audio attachment, and with it the job, unless it's linked to
 * a message or reserved for a response. False when nothing was deleted.
 */
async function deleteAudioJob(audioUploadId: string) {
  const deletedAudioUploadId =
    await attachments.deleteUnlinkedUnreservedAttachment({
      attachmentId: audioUploadId,
      kind: "audio",
    });
  return deletedAudioUploadId !== null;
}

/**
 * A failure the YouTube fetch reported over the queue.
 *
 * Only an unfinished job can fail this way: a report must never turn a job
 * with a transcript into a failed one.
 */
async function failAudioJobById(audioUploadId: string, error: string) {
  await db
    .update(AudioTranscriptionJobs)
    .set({ status: "failed", error })
    .where(
      and(
        eq(AudioTranscriptionJobs.audioUploadId, audioUploadId),
        inArray(AudioTranscriptionJobs.status, ["queued", "processing"]),
      ),
    );
}

/* ------------------------------------------------------------ worker writes */

/**
 * Claim a queued job atomically. Every claim gets a new claimToken, which
 * fences an earlier attempt out of every terminal write if it later finishes.
 */
async function claimAudioJob(audioUploadId: UploadId) {
  const claimToken = randomUUID();
  const [job] = await db
    .update(AudioTranscriptionJobs)
    .set({ status: "processing", claimToken })
    .where(
      and(
        eq(AudioTranscriptionJobs.audioUploadId, audioUploadId),
        eq(AudioTranscriptionJobs.status, "queued"),
      ),
    )
    .returning();

  if (!job) return null;

  const [upload] = await db
    .select({ fileName: Attachments.fileName })
    .from(Attachments)
    .where(eq(Attachments.attachmentId, audioUploadId))
    .limit(1);

  return upload ? { ...job, ...upload, claimToken } : null;
}

/**
 * A terminal transition belongs only to the latest claimant. Returns false when
 * this attempt lost its claim, so its caller can discard the stale result.
 */
async function completeAudioJob(
  audioUploadId: UploadId,
  claimToken: string,
  executor: Executor = db,
) {
  const [row] = await executor
    .update(AudioTranscriptionJobs)
    .set({ status: "completed" })
    .where(
      and(
        eq(AudioTranscriptionJobs.audioUploadId, audioUploadId),
        eq(AudioTranscriptionJobs.status, "processing"),
        eq(AudioTranscriptionJobs.claimToken, claimToken),
      ),
    )
    .returning({ audioUploadId: AudioTranscriptionJobs.audioUploadId });

  return Boolean(row);
}

/**
 * Unclaims a job and resets it to `queued`, so the retry of its delivery
 * claims it as any queued job rather than taking over a claim. Only the
 * current claimant can, and only while the job is processing; false otherwise.
 */
async function unclaimAndResetAudioJob(
  audioUploadId: UploadId,
  claimToken: string,
) {
  const [row] = await db
    .update(AudioTranscriptionJobs)
    .set({ status: "queued", claimToken: null })
    .where(
      and(
        eq(AudioTranscriptionJobs.audioUploadId, audioUploadId),
        eq(AudioTranscriptionJobs.status, "processing"),
        eq(AudioTranscriptionJobs.claimToken, claimToken),
      ),
    )
    .returning({ audioUploadId: AudioTranscriptionJobs.audioUploadId });

  return Boolean(row);
}

/** `error` is shown to the user, so it says what happened, not how. */
async function failAudioJob(
  audioUploadId: UploadId,
  claimToken: string,
  error: string,
) {
  await db
    .update(AudioTranscriptionJobs)
    .set({ status: "failed", error })
    .where(
      and(
        eq(AudioTranscriptionJobs.audioUploadId, audioUploadId),
        eq(AudioTranscriptionJobs.status, "processing"),
        eq(AudioTranscriptionJobs.claimToken, claimToken),
      ),
    );
}

/**
 * Every unfinished job, with what it takes to put it back on its queue, after
 * returning the ones a stopped process left processing to queued. Only for
 * startup, when nothing in this process can be working on one.
 */
async function requeueUnfinishedAudioJobs() {
  return db.transaction(async (tx) => {
    await tx
      .update(AudioTranscriptionJobs)
      .set({ status: "queued", claimToken: null })
      .where(eq(AudioTranscriptionJobs.status, "processing"));

    const queued = await tx
      .select({
        audioUploadId: AudioTranscriptionJobs.audioUploadId,
        source: AudioTranscriptionJobs.source,
        youtubeSourceUrl: AudioTranscriptionJobs.YT_sourceUrl,
        useCaptionsIfAvailable:
          AudioTranscriptionJobs.YT_useCaptionsIfAvailable,
      })
      .from(AudioTranscriptionJobs)
      .where(eq(AudioTranscriptionJobs.status, "queued"));
    // Every job's id was minted as an UploadId.
    return queued.map((job) => ({
      ...job,
      audioUploadId: job.audioUploadId as UploadId,
    }));
  });
}

export const jobs = {
  findAudioJob,
  findJobsPage,
  createAudioJob,
  deleteAudioJob,
  failAudioJobById,
  claimAudioJob,
  completeAudioJob,
  unclaimAndResetAudioJob,
  failAudioJob,
  requeueUnfinishedAudioJobs,
};
