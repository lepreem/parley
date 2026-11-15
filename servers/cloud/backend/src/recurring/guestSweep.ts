import * as guest from "../guest";
import { logger } from "@parley/server-kit/runtime/logger";

const log = logger.child({ component: "guestSweep" });

/** Deletes guests whose sessions have all ended (guest.deleteExpired). */
export async function run() {
  const deleted = await guest.deleteExpired();
  if (deleted > 0) log.info("Swept expired guests", { deleted });
  return deleted;
}

/** Runs every hour. */
export const intervalMs = 60 * 60 * 1000;
