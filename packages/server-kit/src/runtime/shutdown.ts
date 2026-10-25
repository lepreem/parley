import { logger } from "./logger";

const log = logger.child({ component: "shutdown" });

/**
 * Runs `drain` on SIGTERM/SIGINT, then exits.
 *
 * Orchestrators send SIGTERM and SIGKILL some seconds later, so a drain that
 * hangs must not be the thing that decides how long a deploy takes: the hard
 * exit is a backstop, not a fallback path.
 *
 * Both servers are safe to kill outright: the cloud's broker redelivers an
 * unacked message, reclaimed under its fencing token, and the local server
 * queues every unfinished job again at startup. A chat turn completes
 * server-side independently of the response stream. Draining is about not
 * wasting work that was nearly finished, not about correctness.
 */
export function onShutdown(
  drain: () => Promise<void>,
  { graceMs = 15_000 }: { graceMs?: number } = {},
): void {
  let shuttingDown = false;

  const handle = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      log.warn("Second signal received, exiting now", { signal });
      process.exit(1);
      // Not dead code: process.exit is the kind of thing that gets stubbed,
      // and without this the handler would fall through and drain twice.
      return;
    }
    shuttingDown = true;
    log.info("Shutting down", { signal, graceMs });

    const hardExit = setTimeout(() => {
      log.error("Drain exceeded its grace period, exiting anyway", null, {
        graceMs,
      });
      process.exit(1);
    }, graceMs);

    void drain()
      .then(() => {
        clearTimeout(hardExit);
        log.info("Drained cleanly");
        process.exit(0);
      })
      .catch((error) => {
        clearTimeout(hardExit);
        log.error("Drain failed", error);
        process.exit(1);
      });
  };

  process.on("SIGTERM", handle);
  process.on("SIGINT", handle);
}
