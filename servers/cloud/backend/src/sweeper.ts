import { data } from "./data";
import { logger } from "@parley/server-kit/runtime/logger";
import { UPLOAD_CONFIRM_WINDOW_MS, uploads } from "./uploads";

const log = logger.child({ component: "sweeper" });

/**
 * How old an unused object has to be before it's swept: the confirm window
 * plus half again, so a confirm that checked its upload just inside the
 * window has long finished before the sweep can act on the same object.
 */
const GRACE_MS = UPLOAD_CONFIRM_WINDOW_MS * 1.5;
const BATCH_SIZE = 500;
const INTERVAL_MS = 60 * 60 * 1000;
const LOCK_NAME = "storage-sweep";

/**
 * Removes one batch of objects nothing uses — uploads never confirmed, and
 * objects marked deleted whose removal didn't finish — once they're past the
 * grace. Each object leaves storage before its record does, so a crash
 * mid-sweep leaves records to retry, never unrecorded objects.
 *
 * Returns how many were removed, or undefined when another process holds the
 * lock. Anything beyond the batch is next run's.
 *
 * Exposed for tests that drive one batch; production runs it via
 * sweeper.schedule.
 */
async function sweepUnusedObjects() {
  return data.advisoryLock.withAdvisoryLock(LOCK_NAME, async () => {
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

/**
 * Sweeps now and then every interval. The returned function stops the
 * schedule and waits for a sweep in progress. A run still going when the next
 * is due is left to finish rather than joined by a second one.
 */
function schedule(intervalMs = INTERVAL_MS) {
  let inFlight: Promise<void> | undefined;

  const run = () => {
    if (inFlight) return;
    inFlight = sweepUnusedObjects()
      .then(() => undefined)
      .catch((error) => log.error("Sweep failed", error))
      .finally(() => {
        inFlight = undefined;
      });
  };

  run();
  const timer = setInterval(run, intervalMs);

  return async () => {
    clearInterval(timer);
    await inFlight;
  };
}

export const sweeper = {
  schedule,
  sweepUnusedObjects,
};
