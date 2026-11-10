import { and, asc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import {
  AudioTranscriptionJobs,
  StorageLedger,
  db,
  type Executor,
  type storageLedgerStatusEnum,
} from "../db";
import type { StoredObject } from "../storage";

type LedgerEntry = StoredObject & { userId: string };

function isEntry({ userId, kind, uploadId }: LedgerEntry) {
  return and(
    eq(StorageLedger.uploadId, uploadId),
    eq(StorageLedger.userId, userId),
    eq(StorageLedger.kind, kind),
  );
}

function ownedObjects(userId: string, objects: readonly StoredObject[]) {
  return and(
    eq(StorageLedger.userId, userId),
    inArray(
      StorageLedger.uploadId,
      objects.map((object) => object.uploadId),
    ),
  );
}

/** Records an upload whose URL is being handed out. */
async function recordPendingUpload(entry: LedgerEntry) {
  await db.insert(StorageLedger).values({ ...entry, status: "pending" });
}

/**
 * Records objects that rows will reference from the start, without an
 * upload to confirm, such as a YouTube video's audio if the server ever
 * downloads it again.
 */
async function recordConfirmedObjects(
  userId: string,
  objects: readonly StoredObject[],
  executor: Executor = db,
) {
  if (objects.length === 0) return;

  await executor.insert(StorageLedger).values(
    objects.map((object) => ({
      ...object,
      userId,
      status: "confirmed" as const,
    })),
  );
}

/** An object's ledger status and when it was recorded, for this owner and kind. */
async function findLedgerEntry(entry: LedgerEntry) {
  const [row] = await db
    .select({
      status: StorageLedger.status,
      createdAt: StorageLedger.createdAt,
    })
    .from(StorageLedger)
    .where(isEntry(entry));
  return row;
}

/** Entries in any of `statuses` recorded before `createdBefore`, oldest first. */
async function findLedgerEntries({
  statuses,
  createdBefore,
  limit,
}: {
  statuses: readonly (typeof storageLedgerStatusEnum.enumValues)[number][];
  createdBefore: Date;
  limit: number;
}): Promise<LedgerEntry[]> {
  return db
    .select({
      userId: StorageLedger.userId,
      kind: StorageLedger.kind,
      uploadId: StorageLedger.uploadId,
    })
    .from(StorageLedger)
    .where(
      and(
        inArray(StorageLedger.status, [...statuses]),
        lt(StorageLedger.createdAt, createdBefore),
      ),
    )
    .orderBy(asc(StorageLedger.createdAt))
    .limit(limit);
}

/**
 * Confirms a pending upload recorded within the last `withinMs`, and runs
 * `write` — the rows that will reference the object — in the same
 * transaction. Returns false without running `write` when the upload isn't
 * pending and recent any more, which covers a concurrent confirm having got
 * there first.
 */
async function confirmUpload(
  entry: LedgerEntry,
  withinMs: number,
  write: (executor: Executor) => Promise<unknown>,
) {
  return db.transaction(async (tx) => {
    const [confirmed] = await tx
      .update(StorageLedger)
      .set({ status: "confirmed" })
      .where(
        and(
          isEntry(entry),
          eq(StorageLedger.status, "pending"),
          sql`${StorageLedger.createdAt} > now() - make_interval(secs => ${withinMs / 1000})`,
        ),
      )
      .returning({ uploadId: StorageLedger.uploadId });
    if (!confirmed) return false;

    await write(tx);
    return true;
  });
}

/**
 * Marks objects as no longer referenced. Call it in the transaction that
 * removes the last rows pointing at them, so they're never left unrecorded.
 */
async function markDeleted(
  userId: string,
  objects: readonly StoredObject[],
  executor: Executor,
) {
  if (objects.length === 0) return;

  await executor
    .update(StorageLedger)
    .set({ status: "deleted" })
    .where(ownedObjects(userId, objects));
}

/**
 * Marks as deleted the audio of jobs that are done with it, for the sweep to
 * remove: a YouTube job's once it has its transcript, since the video stays
 * on YouTube to play from there, and any finished job's once it was recorded
 * before `recordedBefore`. Audio of a job still queued or processing is kept
 * whatever its age, because the transcription reads it. The job's rows stay;
 * only the object goes. Returns how many were marked.
 */
async function markFinishedAudioDeleted(recordedBefore: Date) {
  const finishedJobs = (onlyYoutube: boolean) =>
    db
      .select({ audioUploadId: AudioTranscriptionJobs.audioUploadId })
      .from(AudioTranscriptionJobs)
      .where(
        onlyYoutube
          ? and(
              eq(AudioTranscriptionJobs.source, "youtube"),
              eq(AudioTranscriptionJobs.status, "completed"),
            )
          : inArray(AudioTranscriptionJobs.status, ["completed", "failed"]),
      );

  const marked = await db
    .update(StorageLedger)
    .set({ status: "deleted" })
    .where(
      and(
        eq(StorageLedger.kind, "audio"),
        eq(StorageLedger.status, "confirmed"),
        or(
          inArray(StorageLedger.uploadId, finishedJobs(true)),
          and(
            lt(StorageLedger.createdAt, recordedBefore),
            inArray(StorageLedger.uploadId, finishedJobs(false)),
          ),
        ),
      ),
    )
    .returning({ uploadId: StorageLedger.uploadId });
  return marked.length;
}

/**
 * Drops the records of objects that are gone from storage. A confirmed
 * record is never dropped: its object is still in use.
 */
async function forgetObjects(
  userId: string,
  objects: readonly StoredObject[],
  executor: Executor = db,
) {
  if (objects.length === 0) return;

  await executor
    .delete(StorageLedger)
    .where(
      and(ownedObjects(userId, objects), ne(StorageLedger.status, "confirmed")),
    );
}

export const storageLedger = {
  recordPendingUpload,
  recordConfirmedObjects,
  findLedgerEntry,
  findLedgerEntries,
  confirmUpload,
  markDeleted,
  markFinishedAudioDeleted,
  forgetObjects,
};
