import { data } from "../data";
import { logger } from "@parley/server-kit/runtime/logger";
import { UPLOAD_CONFIRM_WINDOW_MS, uploads } from "../uploads/uploads";

const log = logger.child({ component: "storageSweep" });

/**
 * How old an unused object has to be before it's swept: the confirm window
 * plus half again, so a confirm that checked its upload just inside the
 * window has long finished before the sweep can act on the same object.
 */
const GRACE_MS = UPLOAD_CONFIRM_WINDOW_MS * 1.5;
/**
 * How long a finished job's uploaded audio stays on the server, for playing it
 * back from another device. The client keeps its own copy for after that.
 * Long enough, too, to replay a failed job's dead-lettered message by hand.
 */
const AUDIO_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 500;
const LOCK_NAME = "storage-sweep";

/**
 * Removes one batch of objects nothing uses — uploads never confirmed, objects
 * marked deleted whose removal didn't finish, and audio no job needs any more
 * (markFinishedAudioDeleted) — once they're past the grace. Each object leaves storage before its record does, so a crash
 * mid-sweep leaves records to retry, never unrecorded objects.
 *
 * Returns how many were removed, or undefined when another process holds the
 * lock. Anything beyond the batch is next run's.
 */
async function sweepUnusedObjects() {
  return data.advisoryLock.withAdvisoryLock(LOCK_NAME, async () => {
    const expired = await data.storageLedger.markFinishedAudioDeleted(
      new Date(Date.now() - AUDIO_RETENTION_MS),
    );
    if (expired > 0)
      log.info("Marked finished jobs' audio deleted", { expired });

    const objects = await data.storageLedger.findLedgerEntries({
      statuses: ["pending", "deleted"],
      createdBefore: new Date(Date.now() - GRACE_MS),
      limit: BATCH_SIZE,
    });

    let removed = 0;
    for (const [userId, owned] of Map.groupBy(objects, (o) => o.userId)) {
      try {
        await uploads.deleteObjects(
          userId,
          owned.map(({ kind, uploadId }) => ({ kind, uploadId })),
        );
        removed += owned.length;
      } catch (error) {
        // One owner's failure shouldn't hold up the rest; the next run retries.
        log.error("Could not remove unused objects", error, {
          userId,
          count: owned.length,
        });
      }
    }

    if (objects.length > 0) {
      log.info("Swept unused objects", {
        found: objects.length,
        removed,
        batchFull: objects.length === BATCH_SIZE,
      });
    }
    return removed;
  });
}

/** Runs every hour, one batch a run. */
export const storageSweep = {
  intervalMs: 60 * 60 * 1000,
  run: sweepUnusedObjects,
};
