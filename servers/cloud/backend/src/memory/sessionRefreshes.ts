/**
 * How long a refresh's result is kept for requests that bring the refresh
 * token it spent. A page whose requests all found the access token expired
 * refreshes from each of them at once, and a request sent just before the
 * browser stored the new cookie still carries the old token; without this,
 * each would ask WorkOS to spend a token that no longer works, and sign the
 * user out.
 */
const REPLAY_WINDOW_MS = 10_000;

const refreshes = new Map<string, Promise<unknown>>();

/**
 * Runs `refresh` once however many callers bring the same refresh token at
 * once or within the replay window. A failure isn't kept, so the next caller
 * runs it again.
 */
function once<T>(refreshToken: string, refresh: () => Promise<T>): Promise<T> {
  const existing = refreshes.get(refreshToken);
  if (existing) return existing as Promise<T>;

  const refreshing = refresh();
  refreshes.set(refreshToken, refreshing);
  refreshing.then(
    () => {
      setTimeout(
        () => refreshes.delete(refreshToken),
        REPLAY_WINDOW_MS,
      ).unref();
    },
    () => refreshes.delete(refreshToken),
  );
  return refreshing;
}

/** The session refreshes this process has running or just finished. */
export const sessionRefreshes = { once };
