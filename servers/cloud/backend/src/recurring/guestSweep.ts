import { data } from "../data";
import { logger } from "@parley/server-kit/runtime/logger";
import { GUEST_SESSION_SECONDS } from "../auth/guestToken";

const log = logger.child({ component: "guestSweep" });

/**
 * A day past the longest a guest session lasts, so a guest still signed in
 * is never swept, whatever the clocks.
 */
const GUEST_LIFETIME_MS = (GUEST_SESSION_SECONDS + 24 * 60 * 60) * 1000;

/**
 * Deletes guests whose sessions have all ended, and what they made. They
 * own nothing in storage (guests chat in text only), so there's nothing to
 * remove there first. Returns how many were deleted.
 */
async function sweepExpiredGuests() {
  const deleted = await data.users.deleteGuestsCreatedBefore(
    new Date(Date.now() - GUEST_LIFETIME_MS),
  );
  if (deleted > 0) log.info("Swept expired guests", { deleted });
  return deleted;
}

/** Runs every hour. */
export const guestSweep = {
  intervalMs: 60 * 60 * 1000,
  run: sweepExpiredGuests,
};
