import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "@parley/server-kit/runtime/withTimeout";

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops the first-progress limit once progress is marked, even with no between-progress limit", async () => {
    const result = withTimeout(
      { timeoutMs: 60_000, firstProgressTimeoutMs: 1_000 },
      async ({ abortSignal, markProgress }) => {
        markProgress();
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return abortSignal.aborted;
      },
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toBe(false);
  });

  it("aborts when the caller's signal does, with its reason", async () => {
    const caller = new AbortController();
    const result = withTimeout(
      { timeoutMs: 60_000, signal: caller.signal },
      ({ abortSignal }) =>
        new Promise((_, reject) => {
          abortSignal.addEventListener("abort", () =>
            reject(abortSignal.reason as Error),
          );
        }),
    );

    caller.abort(new Error("stopped"));
    await expect(result).rejects.toThrow("stopped");
  });
});
