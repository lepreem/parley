import { describe, expect, it, vi } from "vitest";
import {
  measurePreparation,
  stepsInOrder,
  withPreparationMetrics,
  type RecordedStep,
} from "../../src/preparationMetrics";

describe("preparation metrics", () => {
  it("keeps nested operations scoped to their request while requests overlap", async () => {
    const firstLog = { info: vi.fn() };
    const secondLog = { info: vi.fn() };
    const releaseFirst = Promise.withResolvers<void>();
    const first = withPreparationMetrics(
      { log: firstLog, startedAt: performance.now() },
      () =>
        measurePreparation("history", "first-group", async () => {
          await releaseFirst.promise;
          return measurePreparation("database", "query-group", async () => 42);
        }),
    );
    await withPreparationMetrics(
      { log: secondLog, startedAt: performance.now() },
      () => measurePreparation("images", "second-group", async () => "image"),
    );
    releaseFirst.resolve();
    await expect(first).resolves.toBe(42);
    const firstMetrics = firstLog.info.mock.calls.map((call) => call[1]);
    const parent = firstMetrics.find(
      (metric) => metric.operation === "history",
    );
    const child = firstMetrics.find(
      (metric) => metric.operation === "database",
    );
    expect(firstMetrics).toHaveLength(2);
    expect(parent.parentOperationId).toBeUndefined();
    expect(child.parentOperationId).toBe(parent.operationId);
    expect(child.promiseAllId).toBe("query-group");
    expect(child.startOffsetMs).toBeGreaterThanOrEqual(parent.startOffsetMs);
    expect(child.completedAfterMs).toBeLessThanOrEqual(parent.completedAfterMs);
    expect(secondLog.info).toHaveBeenCalledExactlyOnceWith(
      "Message preparation operation completed",
      expect.objectContaining({
        operation: "images",
        parentOperationId: undefined,
        promiseAllId: "second-group",
      }),
    );
  });

  it("records failures and preserves the original error", async () => {
    const log = { info: vi.fn() };
    const error = new Error("Storage unavailable");
    await expect(
      withPreparationMetrics({ log, startedAt: performance.now() }, () =>
        measurePreparation(
          "bucket.createSignedUrls",
          undefined,
          async () => {
            throw error;
          },
          { imageCount: 2 },
        ),
      ),
    ).rejects.toBe(error);
    expect(log.info).toHaveBeenCalledExactlyOnceWith(
      "Message preparation operation completed",
      expect.objectContaining({ outcome: "rejected", imageCount: 2 }),
    );
  });

  it("keeps each step for the turn, its own steps under it", async () => {
    const steps: RecordedStep[] = [];
    const releaseImages = Promise.withResolvers<void>();
    await withPreparationMetrics(
      { log: { info: vi.fn() }, startedAt: performance.now(), steps },
      () =>
        Promise.all([
          measurePreparation("images", undefined, async () => {
            await releaseImages.promise;
            return measurePreparation("signing", undefined, async () => 1);
          }),
          measurePreparation("history", undefined, async () => {
            releaseImages.resolve();
            return 2;
          }),
        ]),
    );

    // Signing started after history did, but it's part of images.
    expect(
      stepsInOrder(steps).map(({ operation, depth }) => ({ operation, depth })),
    ).toEqual([
      { operation: "images", depth: 0 },
      { operation: "signing", depth: 1 },
      { operation: "history", depth: 0 },
    ]);
  });
});
