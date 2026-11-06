import { logger } from "@parley/server-kit/runtime/logger";

const log = logger.child({ component: "recurring" });

/**
 * Runs `task` now and then every `intervalMs`, until the returned function is
 * called; that stops the schedule and waits for a run in progress. A run still
 * going when the next is due is left to finish rather than joined by a second
 * one, and a run that fails is logged under `name` and tried again next time.
 */
export function every(
  name: string,
  intervalMs: number,
  task: () => Promise<unknown>,
) {
  let inFlight: Promise<void> | undefined;

  const run = () => {
    if (inFlight) return;
    inFlight = task()
      .then(
        () => undefined,
        (error: unknown) => log.error("Recurring task failed", error, { name }),
      )
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
