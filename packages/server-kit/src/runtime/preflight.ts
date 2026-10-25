import { logger, messageOf } from "./logger";

type ServiceCheck = {
  /** Human-readable service name, shown in the startup error. */
  name: string;
  /** Lightweight call that rejects if the service is unavailable. */
  check: () => Promise<unknown>;
};

/**
 * Why a check failed, for the startup error. A program that couldn't be found
 * says so, rather than as Node's "spawn yt-dlp ENOENT".
 */
function reasonOf(reason: unknown) {
  if ((reason as NodeJS.ErrnoException | null)?.code === "ENOENT") {
    return "not installed, or not on PATH. The repo root's npm scripts provide it through mise";
  }
  return messageOf(reason);
}

/**
 * Runs every health check and aborts startup if any third-party service is
 * unavailable. Checks run concurrently so a single boot reports *all* failing
 * services at once rather than one at a time.
 */
export async function verifyServices(checks: ServiceCheck[]): Promise<void> {
  const results = await Promise.allSettled(checks.map((c) => c.check()));

  const failures = results.flatMap((result, i) =>
    result.status === "rejected"
      ? [{ name: checks[i].name, reason: result.reason }]
      : [],
  );

  if (failures.length > 0) {
    for (const { name, reason } of failures)
      logger.error(`Service unavailable at startup: ${name}`, reason);

    const detail = failures
      .map(({ name, reason }) => {
        return `  - ${name}: ${reasonOf(reason)}`;
      })
      .join("\n");
    throw new Error(
      `Startup aborted — the following services are unavailable:\n${detail}`,
    );
  }
}
