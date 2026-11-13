import { sql } from "drizzle-orm";
import { db } from "../db";

/**
 * Runs `run` while holding the named lock, or returns undefined without
 * running it when another process holds it. The lock belongs to the
 * transaction, so it is released however the run ends — including the
 * process dying.
 */
export async function withAdvisoryLock<T>(
  name: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${name})) as locked`,
    );
    if (!row?.locked) return undefined;
    return run();
  });
}
