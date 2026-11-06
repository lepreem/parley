/**
 * How many Postgres connections the API may hold, and how many it opens at
 * startup.
 *
 * Supabase's session pooler admits a fixed number of clients across every
 * process on the project, and refuses the next one outright (`EMAXCONNSESSION
 * max clients reached in session mode`) rather than queueing it. postgres.js
 * defaults to 10 and never closes idle connections, so a process holds every
 * connection it ever opened.
 *
 * What shares the pooler: the deployed API; the migrate one-shot's single
 * connection, which a deploy runs beside the old API (compose stops the old
 * API before starting the new one, so two never overlap); and, while
 * production shares the dev Supabase project, a local API or test run. Each
 * extra API instance takes its own pool, so adding one means shrinking this.
 */
export const SESSION_POOLER_CLIENT_LIMIT = 15;

/** The migrate one-shot's client (scripts/migrate.ts). */
export const MIGRATION_CONNECTIONS = 1;

export const DATABASE_POOL = {
  /**
   * postgres.js `max`: queries beyond it wait for a free connection. A
   * message turn can fire five queries at once, beside transcriptions being
   * saved and the storage sweep, which holds one connection for its lock.
   */
  size: 7,
  /**
   * Connections pingDb opens at startup, so early requests skip the ~1.5 s it
   * costs to open one. Enough for a message turn's five.
   */
  connectionsToWarm: 5,
} as const;
