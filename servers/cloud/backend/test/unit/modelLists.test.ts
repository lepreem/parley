import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CACHE_KEYS,
  getOrSetCache,
  resetCacheMemo,
} from "../../src/memory/modelLists";

const TTL_MS = 60 * 60 * 1000;

beforeEach(() => {
  resetCacheMemo();
});

describe("getOrSetCache", () => {
  it("fetches on the first read and serves the memo after", async () => {
    const fetch = vi.fn(async () => ({ some: "catalog" }));

    expect(await getOrSetCache(CACHE_KEYS.openRouterModels, fetch)).toEqual({
      some: "catalog",
    });
    expect(await getOrSetCache(CACHE_KEYS.openRouterModels, fetch)).toEqual({
      some: "catalog",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("shares one fetch between callers that miss together", async () => {
    const fetch = vi.fn(async () => ({ some: "catalog" }));

    const [first, second] = await Promise.all([
      getOrSetCache(CACHE_KEYS.openRouterModels, fetch),
      getOrSetCache(CACHE_KEYS.openRouterModels, fetch),
    ]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("keeps each key's fetch separate", async () => {
    const [models, transcribeModels] = await Promise.all([
      getOrSetCache(CACHE_KEYS.openRouterModels, async () => "models"),
      getOrSetCache(
        CACHE_KEYS.deepgramTranscribeModels,
        async () => "transcribe-models",
      ),
    ]);

    expect(models).toBe("models");
    expect(transcribeModels).toBe("transcribe-models");
  });

  it("rejects every waiter and fetches again after a failure", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("upstream is down"))
      .mockResolvedValueOnce({ some: "catalog" });

    const [first, second] = await Promise.allSettled([
      getOrSetCache(CACHE_KEYS.openRouterModels, fetch),
      getOrSetCache(CACHE_KEYS.openRouterModels, fetch),
    ]);

    expect(first).toMatchObject({ reason: new Error("upstream is down") });
    expect(second).toMatchObject({ reason: new Error("upstream is down") });
    expect(fetch).toHaveBeenCalledTimes(1);

    expect(await getOrSetCache(CACHE_KEYS.openRouterModels, fetch)).toEqual({
      some: "catalog",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("getOrSetCache once the memo has expired", () => {
  const STALE = { serveStale: true };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await getOrSetCache(
      CACHE_KEYS.openRouterModels,
      async () => "old catalog",
      STALE,
    );
    vi.advanceTimersByTime(TTL_MS + 1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the refresh without serveStale", async () => {
    expect(
      await getOrSetCache(
        CACHE_KEYS.openRouterModels,
        async () => "new catalog",
      ),
    ).toBe("new catalog");
  });

  it("serves the old value without waiting on the refresh", async () => {
    const refreshed = Promise.withResolvers<string>();
    const fetch = vi.fn(() => refreshed.promise);

    expect(await getOrSetCache(CACHE_KEYS.openRouterModels, fetch, STALE)).toBe(
      "old catalog",
    );

    refreshed.resolve("new catalog");
    await vi.waitFor(async () =>
      expect(
        await getOrSetCache(CACHE_KEYS.openRouterModels, fetch, STALE),
      ).toBe("new catalog"),
    );
  });

  it("keeps serving the old value when the refresh fails, and retries", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("upstream is down"))
      .mockResolvedValueOnce("new catalog");

    expect(await getOrSetCache(CACHE_KEYS.openRouterModels, fetch, STALE)).toBe(
      "old catalog",
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    expect(await getOrSetCache(CACHE_KEYS.openRouterModels, fetch, STALE)).toBe(
      "old catalog",
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () =>
      expect(
        await getOrSetCache(CACHE_KEYS.openRouterModels, fetch, STALE),
      ).toBe("new catalog"),
    );
  });

  it("starts one refresh for callers that find it expired together", async () => {
    const refreshed = Promise.withResolvers<string>();
    const fetch = vi.fn(() => refreshed.promise);

    await Promise.all([
      getOrSetCache(CACHE_KEYS.openRouterModels, fetch, STALE),
      getOrSetCache(CACHE_KEYS.openRouterModels, fetch, STALE),
    ]);
    refreshed.resolve("new catalog");

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
