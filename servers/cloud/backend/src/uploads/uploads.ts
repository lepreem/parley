import { bucket, type StoredObject, type UploadableObject } from "../storage";
import type { Executor } from "../db";
import { data } from "../data";

/**
 * How long after its URL is handed out an upload can still be confirmed. At
 * least as long as the URL itself is valid, so no upload can land after the
 * window has closed — verifyUploadUrlLifetime checks that at startup.
 */
export const UPLOAD_CONFIRM_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * An upload URL for a new object, recorded as pending. The URL isn't
 * returned unless the record exists, so no upload can land unrecorded.
 */
async function start(userId: string, object: UploadableObject) {
  const [, signedUrl] = await Promise.all([
    data.storageLedger.recordPendingUpload({ userId, ...object }),
    bucket.createUploadUrl(userId, object),
  ]);

  return signedUrl;
}

/**
 * Whether an upload can be confirmed, and what storage says it is. Writes
 * nothing either way: a rejected upload stays pending, and the sweep removes
 * it once it's past its grace.
 */
async function check(userId: string, object: UploadableObject) {
  const entry = await data.storageLedger.findLedgerEntry({ userId, ...object });

  if (entry?.status === "confirmed") {
    return { ok: false, reason: "already-confirmed" } as const;
  }
  if (entry?.status !== "pending") {
    return { ok: false, reason: "missing" } as const;
  }
  if (Date.now() - entry.createdAt.getTime() > UPLOAD_CONFIRM_WINDOW_MS) {
    return { ok: false, reason: "expired" } as const;
  }

  return bucket.inspectUploadedObject(userId, object);
}

/**
 * Confirms a checked upload and writes the rows that reference it, in one
 * transaction. False when it's no longer pending and in its window — another
 * confirm got there first.
 */
async function confirm(
  userId: string,
  object: UploadableObject,
  write: (executor: Executor) => Promise<unknown>,
) {
  return data.storageLedger.confirmUpload(
    { userId, ...object },
    UPLOAD_CONFIRM_WINDOW_MS,
    write,
  );
}

/**
 * Deletes objects marked deleted (or never confirmed) from storage, then
 * their records. A failure leaves the records for the sweep.
 */
async function deleteObjects(
  userId: string,
  objects: readonly StoredObject[],
  executor?: Executor,
) {
  if (objects.length === 0) return;

  await bucket.delete(userId, objects);
  await data.storageLedger.forgetObjects(userId, objects, executor);
}

/**
 * An object's way into storage and back out: a URL to upload it to, the
 * check and confirm once it has landed, and its deletion.
 */
export const uploads = {
  start,
  check,
  confirm,
  deleteObjects,
};
