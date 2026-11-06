import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockWithAdvisoryLock,
  mockFindLedgerEntries,
  mockMarkFinishedAudioDeleted,
  mockDeleteObjects,
  mockDeleteGuestsCreatedBefore,
} = vi.hoisted(() => ({
  mockWithAdvisoryLock: vi.fn(),
  mockFindLedgerEntries: vi.fn(),
  mockMarkFinishedAudioDeleted: vi.fn(),
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
    markFinishedAudioDeleted: mockMarkFinishedAudioDeleted,
  },
}));
vi.mock("../../src/data/users.data", () => ({
  users: { deleteGuestsCreatedBefore: mockDeleteGuestsCreatedBefore },
}));
vi.mock("../../src/uploads/uploads", () => ({
  UPLOAD_CONFIRM_WINDOW_MS: 2 * 60 * 60 * 1000,
  uploads: { deleteObjects: mockDeleteObjects },
}));

import { recurring } from "../../src/recurring";
import { every } from "../../src/recurring/every";
import { guestSweep } from "../../src/recurring/guestSweep";
import { storageSweep } from "../../src/recurring/storageSweep";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

beforeEach(() => {
  vi.clearAllMocks();
  mockWithAdvisoryLock.mockImplementation(
    async (_name: string, run: () => unknown) => run(),
  );
  mockFindLedgerEntries.mockResolvedValue([]);
  mockMarkFinishedAudioDeleted.mockResolvedValue(0);
  mockDeleteObjects.mockResolvedValue(undefined);
  mockDeleteGuestsCreatedBefore.mockResolvedValue(0);
});

describe("guestSweep.run", () => {
  it("deletes guests a day older than the longest guest session", async () => {
    mockDeleteGuestsCreatedBefore.mockResolvedValue(3);
    const before = Date.now();

    expect(await guestSweep.run()).toBe(3);

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

describe("storageSweep.run", () => {
  it("asks for unused objects past the grace, one batch at a time", async () => {
    const before = Date.now();

    await storageSweep.run();

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

  it("first marks deleted the audio of jobs finished a week ago", async () => {
    const before = Date.now();

    await storageSweep.run();

    const [recordedBefore] = mockMarkFinishedAudioDeleted.mock.calls[0] as [
      Date,
    ];
    expect(recordedBefore.getTime()).toBeGreaterThanOrEqual(
      before - 7 * 24 * HOUR_MS,
    );
    expect(recordedBefore.getTime()).toBeLessThanOrEqual(
      Date.now() - 7 * 24 * HOUR_MS,
    );
    // So the same run removes what it just marked.
    expect(
      mockMarkFinishedAudioDeleted.mock.invocationCallOrder[0],
    ).toBeLessThan(mockFindLedgerEntries.mock.invocationCallOrder[0]);
  });

  it("releases each owner's objects together", async () => {
    mockFindLedgerEntries.mockResolvedValue([
      { userId: "u1", kind: "image", uploadId: "i1" },
      { userId: "u2", kind: "audio", uploadId: "a1" },
      { userId: "u1", kind: "audio", uploadId: "a2" },
    ]);

    expect(await storageSweep.run()).toBe(3);
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

    expect(await storageSweep.run()).toBe(1);
    expect(mockDeleteObjects).toHaveBeenCalledTimes(2);
  });

  it("does nothing while another process holds the lock", async () => {
    mockWithAdvisoryLock.mockResolvedValue(undefined);

    expect(await storageSweep.run()).toBeUndefined();
    expect(mockFindLedgerEntries).not.toHaveBeenCalled();
  });
});

describe("every", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs at once, then every interval, until stopped", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const stop = every("test", HOUR_MS, task);
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(task).toHaveBeenCalledTimes(2);

    await stop();
    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("doesn't start a run while the last one is still going", async () => {
    let finish!: () => void;
    const task = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => (finish = resolve)),
      )
      .mockResolvedValue(undefined);

    const stop = every("test", HOUR_MS, task);
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);
    expect(task).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(task).toHaveBeenCalledTimes(2);
    await stop();
  });

  it("waits for a run in progress when stopped", async () => {
    let finish!: () => void;
    const task = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );

    const stop = every("test", HOUR_MS, task);
    let stopped = false;
    void stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(true);
  });

  it("survives a failed run", async () => {
    const task = vi
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue(undefined);

    const stop = every("test", HOUR_MS, task);
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(task).toHaveBeenCalledTimes(2);
    await stop();
  });
});

describe("recurring.start", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs both sweeps at once, then every hour, until stopped", async () => {
    const stop = recurring.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(mockDeleteGuestsCreatedBefore).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(2);
    expect(mockDeleteGuestsCreatedBefore).toHaveBeenCalledTimes(2);

    await stop();
    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(2);
  });

  it("sweeps guests even when the storage sweep fails", async () => {
    mockWithAdvisoryLock.mockRejectedValueOnce(new Error("db down"));

    const stop = recurring.start();
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(mockDeleteGuestsCreatedBefore).toHaveBeenCalledTimes(2);
    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(2);
    await stop();
  });
});
