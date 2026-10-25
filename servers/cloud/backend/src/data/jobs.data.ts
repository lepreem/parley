import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { Attachments, AudioTranscriptionJobs, db, type Executor } from "../db";
import type { jobStatusEnum } from "../db";
import type { UploadId } from "@parley/server-kit/ids";
import { attachments } from "./attachments.data";
import { storageLedger } from "./storageLedger.data";

/**
 * The API reads and writes this table both on the request path and as
 * transcription moves a job through its states.
 *
 * Types are derived from the schema rather than imported from the request
 * schemas: the data layer doesn't depend on the HTTP one.
 */
type JobStatus = (typeof jobStatusEnum.enumValues)[number];

type AudioJobRow = typeof AudioTranscriptionJobs.$inferSelect;

/* ---------------------------------------------------------------- API reads */

async function findAudioJob(userId: string, audioUploadId: string) {
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
    .where(
      and(
        eq(AudioTranscriptionJobs.audioUploadId, audioUploadId),
        eq(Attachments.userId, userId),
      ),
    )
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
 * DESC order. Casts the cursor timestamp in SQL so it works regardless of the
 * column's driver read mode.
 */
function afterCursor(
  createdAtCol: AnyPgColumn,
  audioUploadIdCol: AnyPgColumn,
  cursor: JobCursor | null,
) {
  if (!cursor) return undefined;
  const cursorCreatedAt = sql`${cursor.createdAt}::timestamptz`;
  return or(
    lt(createdAtCol, cursorCreatedAt),
    and(
      eq(createdAtCol, cursorCreatedAt),
      lt(audioUploadIdCol, cursor.audioUploadId),
    ),
  );
}

type JobsPageFilters = {
  userId: string;
  status?: JobStatus;
  searchQuery?: string;
  cursor: JobCursor | null;
  fetchCount: number;
};

/**
 * One page of the user's history, newest first. Returns whatever `fetchCount`
 * yields — the caller over-fetches to detect a next page, and owns the cursor
 * encoding. The audioUploadId tiebreak in the ordering is what makes the keyset
 * cursor deterministic.
 */
async function findUserJobsPage(
  filters: JobsPageFilters,
): Promise<JobSummary[]> {
  const { userId, status, searchQuery, cursor, fetchCount } = filters;

  return db
    .select(audioJobColumns)
    .from(AudioTranscriptionJobs)
    .innerJoin(
      Attachments,
      eq(Attachments.attachmentId, AudioTranscriptionJobs.audioUploadId),
    )
    .where(
      and(
        eq(Attachments.userId, userId),
        eq(Attachments.kind, "audio"),
        status ? eq(AudioTranscriptionJobs.status, status) : undefined,
        searchQuery
          ? ilike(Attachments.fileName, `%${searchQuery}%`)
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

/**
 * The attachment row and the job row, together. `executor` lets a direct
 * upload's confirm write them in the transaction that confirms the upload.
 */
async function createAudioJob(
  job: {
    audioUploadId: UploadId;
    userId: string;
    source: AudioJobRow["source"];
    fileName: string;
    mimeType: string | null;
    sizeBytes: number;
    transcriptModelId: string;
    youtubeSourceUrl?: string;
  },
  executor: Executor = db,
) {
  const {
    audioUploadId,
    userId,
    source,
    fileName,
    mimeType,
    sizeBytes,
    transcriptModelId,
    youtubeSourceUrl,
  } = job;

  await executor.transaction(async (tx) => {
    await attachments.createAttachment(
      {
        attachmentId: audioUploadId,
        kind: "audio",
        userId,
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
    });
  });
}

/**
 * A YouTube job, and the audio the fetcher may write for it recorded as
 * referenced, in the same transaction. It's recorded now rather than when it
 * lands, so audio the fetcher writes is never unrecorded; recording audio that
 * never arrives (the video had captions) costs nothing, since deleting a
 * missing object is a no-op.
 */
async function createYoutubeAudioJob(
  job: Parameters<typeof createAudioJob>[0],
) {
  await db.transaction(async (tx) => {
    await createAudioJob(job, tx);
    await storageLedger.recordConfirmedObjects(
      job.userId,
      [{ kind: "audio", uploadId: job.audioUploadId }],
      tx,
    );
  });
}

/**
 * Deletes a job's audio attachment, and with it the job, unless it's linked to
 * a message or reserved for a response. Marks the audio as deleted in the same
 * transaction. Returns null when nothing was deleted, and otherwise says
 * whether its fetch could still write the audio the caller is about to remove.
 */
async function deleteAudioJob(userId: string, audioUploadId: string) {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select({
        source: AudioTranscriptionJobs.source,
        status: AudioTranscriptionJobs.status,
      })
      .from(AudioTranscriptionJobs)
      .where(eq(AudioTranscriptionJobs.audioUploadId, audioUploadId));

    const deletedAudioUploadId =
      await attachments.deleteOwnedUnlinkedUnreservedAttachment(
        { userId, attachmentId: audioUploadId, kind: "audio" },
        tx,
      );
    if (!deletedAudioUploadId) return null;

    // A youtube fetch runs in another process that nothing here can stop, so
    // until the job reaches a terminal status its objects may still land.
    const fetchMayStillWrite =
      job?.source === "youtube" &&
      job.status !== "completed" &&
      job.status !== "failed";

    return { fetchMayStillWrite };
  });
}

/**
 * Out-of-band failure reported by youtube-fetcher over the broker. Not
 * user-scoped: the event carries no session, only the id it was given.
 *
 * Only an unfinished job can fail this way. A report can arrive after the
 * job completed — a redelivered fetch that fails the second time — and must
 * not turn a job with a transcript into a failed one.
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
 * Claim a queued job atomically. A broker-redelivered message may also reclaim
 * `processing`: losing the old consumer connection requeues its unACKed message,
 * but does not prove the old process stopped. Replacing claimToken fences that
 * worker out of every terminal write if it later finishes.
 */
async function claimAudioJob(
  audioUploadId: UploadId,
  allowProcessingRecovery = false,
) {
  const claimToken = randomUUID();
  const [job] = await db
    .update(AudioTranscriptionJobs)
    .set({ status: "processing", claimToken })
    .where(
      and(
        eq(AudioTranscriptionJobs.audioUploadId, audioUploadId),
        allowProcessingRecovery
          ? inArray(AudioTranscriptionJobs.status, ["queued", "processing"])
          : eq(AudioTranscriptionJobs.status, "queued"),
      ),
    )
    .returning();

  if (!job) return null;

  const [upload] = await db
    .select({
      userId: Attachments.userId,
      fileName: Attachments.fileName,
    })
    .from(Attachments)
    .where(eq(Attachments.attachmentId, audioUploadId))
    .limit(1);

  return upload ? { ...job, ...upload, claimToken } : null;
}

/**
 * A terminal transition belongs only to the latest claimant. Returns false when
 * this worker lost ownership, so its caller can discard the stale result.
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

/**
 * `error` is shown to the user, so it says what happened, not how. Returns
 * false when this worker lost ownership, as completeAudioJob does.
 */
async function failAudioJob(
  audioUploadId: UploadId,
  claimToken: string,
  error: string,
) {
  const [row] = await db
    .update(AudioTranscriptionJobs)
    .set({ status: "failed", error })
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

export const jobs = {
  findAudioJob,
  findUserJobsPage,
  createAudioJob,
  createYoutubeAudioJob,
  deleteAudioJob,
  failAudioJobById,
  claimAudioJob,
  completeAudioJob,
  unclaimAndResetAudioJob,
  failAudioJob,
};
