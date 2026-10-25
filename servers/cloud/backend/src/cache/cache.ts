import { logger } from "@parley/server-kit/runtime/logger";
import { CACHE_KEYS, type CacheKey } from "./cacheKeys";

/**
 * How long a process serves each entry before fetching it again. Each process
 * holds its own copy, so a restart fetches once more. An hour keeps a newly
 * listed model from waiting long, and costs the provider one catalog call an
 * hour, made in the background once a value is held (see getOrSetCache).
 */
const CACHE_TTL_MS = {
  [CACHE_KEYS.openRouterModels]: 60 * 60 * 1000,
  [CACHE_KEYS.deepgramTranscribeModels]: 60 * 60 * 1000,
} as const satisfies Record<CacheKey, number>;

const memo = new Map<CacheKey, { data: unknown; expiresAt: number }>();
const inFlight = new Map<CacheKey, Promise<unknown>>();

/**
 * The read-through path: the in-process memo, then `fetch`.
 *
 * With `serveStale`, only a process's first read waits on the fetch. Once the
 * memo holds a value it is returned at once: when it has expired, it is
 * served as it is while a refresh runs in the background, so the request that
 * finds it expired doesn't pay for the refresh. A refresh that fails leaves
 * the old value in place, and the next read starts another. Without it, a
 * read that finds the memo expired waits for the refresh.
 */
export async function getOrSetCache<T>(
  name: CacheKey,
  fetch: () => Promise<T>,
  { serveStale = false }: { serveStale?: boolean } = {},
): Promise<T> {
  const memoized = memo.get(name);
  if (memoized && memoized.expiresAt > Date.now()) return memoized.data as T;
  if (!memoized || !serveStale) return refresh(name, fetch);

  // if accepts stale, run the refresh in background while immediately returning stale memozied.
  refresh(name, fetch).catch((error: unknown) =>
    logger.error("Cache refresh failed", error, { cacheKey: name }),
  );
  return memoized.data as T;
}

/**
 * Runs `fetch` and memoizes what it returns. Callers that refresh together
 * share one run per process instead of each starting their own, so a burst
 * of requests makes one catalog call, not one each. The shared run is
 * dropped once it settles, so a failed fetch is retried rather than handed to
 * every later caller.
 */
function refresh<T>(name: CacheKey, fetch: () => Promise<T>): Promise<T> {
  const pending = inFlight.get(name);
  if (pending) return pending as Promise<T>;

  // Nothing is awaited between reading and writing inFlight, so no two
  // callers can both find it empty.
  const refreshed = (async () => {
    const data = await fetch();
    memo.set(name, { data, expiresAt: Date.now() + CACHE_TTL_MS[name] });
    return data;
  })().finally(() => inFlight.delete(name));

  inFlight.set(name, refreshed);
  return refreshed;
}

/** Test-only: drops the in-process state so cases don't leak entries into each other. */
export function resetCacheMemo() {
  memo.clear();
  inFlight.clear();
}

/** An in-process memo; resetCacheMemo stays out of it, being for tests. */
export const cache = {
  getOrSet: getOrSetCache,
};
