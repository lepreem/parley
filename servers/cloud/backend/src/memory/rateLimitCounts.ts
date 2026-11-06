import { MemoryStore } from "hono-rate-limiter";

const stores: MemoryStore[] = [];

/**
 * Somewhere for one rate limit to count, in this process's memory. The API
 * runs as one instance, so the counts are exact and no request waits on a
 * round trip to a shared store. With several instances each would count on
 * its own; see TODO.md before scaling out.
 */
function createStore() {
  const store = new MemoryStore();
  stores.push(store);
  return store;
}

/** Test-only: clears every count, so cases don't spend each other's budgets. */
export function resetRateLimits() {
  for (const store of stores) store.resetAll();
}

/** What rate limits count with; resetRateLimits stays out of it, being for tests. */
export const rateLimitCounts = { createStore };
