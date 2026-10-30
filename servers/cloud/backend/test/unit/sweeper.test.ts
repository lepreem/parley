import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockWithAdvisoryLock,
  mockFindLedgerEntries,
  mockDeleteObjects,
  mockDeleteGuestsCreatedBefore,
} = vi.hoisted(() => ({
  mockWithAdvisoryLock: vi.fn(),
  mockFindLedgerEntries: vi.fn(),
  mockDeleteObjects: vi.fn(),
  mockDeleteGuestsCreatedBefore: vi.fn(),
}));

vi.mock("../../src/data/advisoryLock.data", () => ({
  advisoryLock: {
    withAdvisoryLock: mockWithAdvisoryLock,
  },
}));
vi.mock("../../src/data/storageLedger.data", () => ({
  storageLedger: {
    findLedgerEntries: mockFindLedgerEntries,
  },
}));
vi.mock("../../src/data/users.data", () => ({
  users: { deleteGuestsCreatedBefore: mockDeleteGuestsCreatedBefore },
}));
vi.mock("../../src/uploads", () => ({
  UPLOAD_CONFIRM_WINDOW_MS: 2 * 60 * 60 * 1000,
  uploads: { deleteObjects: mockDeleteObjects },
}));

import { sweeper } from "../../src/sweeper";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

beforeEach(() => {
  vi.clearAllMocks();
  mockWithAdvisoryLock.mockImplementation(
    async (_name: string, run: () => unknown) => run(),
  );
  mockFindLedgerEntries.mockResolvedValue([]);
  mockDeleteObjects.mockResolvedValue(undefined);
  mockDeleteGuestsCreatedBefore.mockResolvedValue(0);
});

describe("sweeper.sweepExpiredGuests", () => {
  it("deletes guests a day older than the longest guest session", async () => {
    mockDeleteGuestsCreatedBefore.mockResolvedValue(3);
    const before = Date.now();

    expect(await sweeper.sweepExpiredGuests()).toBe(3);

    const [createdBefore] = mockDeleteGuestsCreatedBefore.mock.calls[0] as [
      Date,
    ];
    expect(createdBefore.getTime()).toBeGreaterThanOrEqual(
      before - 31 * DAY_MS,
    );
    expect(createdBefore.getTime()).toBeLessThanOrEqual(
      Date.now() - 31 * DAY_MS,
    );
  });
});

describe("sweeper.sweepUnusedObjects", () => {
  it("asks for unused objects past the grace, one batch at a time", async () => {
    const before = Date.now();

    await sweeper.sweepUnusedObjects();

    const [{ statuses, createdBefore, limit }] = mockFindLedgerEntries.mock
      .calls[0] as [{ statuses: string[]; createdBefore: Date; limit: number }];
    expect(statuses).toEqual(["pending", "deleted"]);
    expect(limit).toBe(500);
    // Three hours: the two-hour confirm window plus half again.
    expect(createdBefore.getTime()).toBeGreaterThanOrEqual(
      before - 3 * HOUR_MS,
    );
    expect(createdBefore.getTime()).toBeLessThanOrEqual(
      Date.now() - 3 * HOUR_MS,
    );
  });

  it("releases each owner's objects together", async () => {
    mockFindLedgerEntries.mockResolvedValue([
      { userId: "u1", kind: "image", uploadId: "i1" },
      { userId: "u2", kind: "audio", uploadId: "a1" },
      { userId: "u1", kind: "audio", uploadId: "a2" },
    ]);

    expect(await sweeper.sweepUnusedObjects()).toBe(3);
    expect(mockDeleteObjects).toHaveBeenCalledTimes(2);
    expect(mockDeleteObjects).toHaveBeenCalledWith("u1", [
      { kind: "image", uploadId: "i1" },
      { kind: "audio", uploadId: "a2" },
    ]);
    expect(mockDeleteObjects).toHaveBeenCalledWith("u2", [
      { kind: "audio", uploadId: "a1" },
    ]);
  });

  it("keeps going past an owner whose release fails", async () => {
    mockFindLedgerEntries.mockResolvedValue([
      { userId: "u1", kind: "image", uploadId: "i1" },
      { userId: "u2", kind: "image", uploadId: "i2" },
    ]);
    mockDeleteObjects.mockRejectedValueOnce(new Error("storage down"));

    expect(await sweeper.sweepUnusedObjects()).toBe(1);
    expect(mockDeleteObjects).toHaveBeenCalledTimes(2);
  });

  it("does nothing while another process holds the lock", async () => {
    mockWithAdvisoryLock.mockResolvedValue(undefined);

    expect(await sweeper.sweepUnusedObjects()).toBeUndefined();
    expect(mockFindLedgerEntries).not.toHaveBeenCalled();
  });
});

describe("sweeper.schedule", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sweeps at once, then every interval, until stopped", async () => {
    const stop = sweeper.schedule(HOUR_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(2);

    await stop();
    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(2);
  });

  it("doesn't start a run while the last one is still going", async () => {
    let finish!: () => void;
    mockWithAdvisoryLock.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );

    const stop = sweeper.schedule(HOUR_MS);
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);
    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(2);
    await stop();
  });

  it("waits for a run in progress when stopped", async () => {
    let finish!: () => void;
    mockWithAdvisoryLock.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );

    const stop = sweeper.schedule(HOUR_MS);
    let stopped = false;
    void stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(true);
  });

  it("sweeps guests on each run, apart from the objects", async () => {
    mockWithAdvisoryLock.mockRejectedValueOnce(new Error("db down"));

    const stop = sweeper.schedule(HOUR_MS);
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(mockDeleteGuestsCreatedBefore).toHaveBeenCalledTimes(2);
    await stop();
  });

  it("survives a failed run", async () => {
    mockWithAdvisoryLock.mockRejectedValueOnce(new Error("db down"));

    const stop = sweeper.schedule(HOUR_MS);
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(2);
    await stop();
  });
});
