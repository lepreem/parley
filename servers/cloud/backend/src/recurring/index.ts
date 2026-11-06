import { every } from "./every";
import { guestSweep } from "./guestSweep";
import { storageSweep } from "./storageSweep";

/**
 * Everything the API runs over and over on a timer, each on its own interval.
 * Every instance starts them; a task that must not run twice at once takes its
 * own lock (the storage sweep does). The returned function stops them all and
 * waits for runs in progress.
 */
function start() {
  const stops = [
    every("storageSweep", storageSweep.intervalMs, storageSweep.run),
    every("guestSweep", guestSweep.intervalMs, guestSweep.run),
  ];

  return async () => {
    await Promise.all(stops.map((stop) => stop()));
  };
}

export const recurring = { start };
