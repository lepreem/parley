import { beforeEach, describe, expect, it, vi } from "vitest";

const { bucket, ledger } = vi.hoisted(() => ({
  bucket: {
    createUploadUrl: vi.fn(),
    delete: vi.fn(),
    inspectUploadedObject: vi.fn(),
  },
  ledger: {
    recordPendingUpload: vi.fn(),
    findLedgerEntry: vi.fn(),
    confirmUpload: vi.fn(),
    forgetObjects: vi.fn(),
  },
}));

vi.mock("../../src/storage/bucket", () => ({ bucket }));
vi.mock("../../src/data/storageLedger.data", () => ({
  storageLedger: ledger,
}));

import { uploads } from "../../src/uploads/uploads";

const USER = "user_01";
const HOUR_MS = 60 * 60 * 1000;
const WINDOW_MS = 2 * HOUR_MS;
const image = { kind: "image", uploadId: "i1" } as const;
const pending = (msAgo = 0) => ({
  status: "pending",
  createdAt: new Date(Date.now() - msAgo),
});

beforeEach(() => {
  vi.clearAllMocks();
  bucket.createUploadUrl.mockResolvedValue("https://upload");
  bucket.delete.mockResolvedValue([]);
  ledger.recordPendingUpload.mockResolvedValue(undefined);
  ledger.findLedgerEntry.mockResolvedValue(pending());
  ledger.forgetObjects.mockResolvedValue(undefined);
});

describe("uploads.start", () => {
  it("records the upload and returns its URL", async () => {
    expect(await uploads.start(USER, image)).toBe("https://upload");
    expect(ledger.recordPendingUpload).toHaveBeenCalledWith({
      userId: USER,
      ...image,
    });
  });

  it("returns no URL when the record can't be written", async () => {
    ledger.recordPendingUpload.mockRejectedValue(new Error("db down"));

    await expect(uploads.start(USER, image)).rejects.toThrow("db down");
  });
});

describe("uploads.check", () => {
  it("passes on what storage reports for a recent pending upload", async () => {
    bucket.inspectUploadedObject.mockResolvedValue({
      ok: true,
      sizeBytes: 5,
      contentType: "image/png",
    });

    expect(await uploads.check(USER, image)).toEqual({
      ok: true,
      sizeBytes: 5,
      contentType: "image/png",
    });
    expect(ledger.findLedgerEntry).toHaveBeenCalledWith({
      userId: USER,
      ...image,
    });
  });

  it.each([
    [undefined, "missing"],
    [{ status: "deleted", createdAt: new Date() }, "missing"],
    [{ status: "confirmed", createdAt: new Date() }, "already-confirmed"],
    [pending(WINDOW_MS + 1000), "expired"],
  ])("answers %o with %s, without asking storage", async (entry, reason) => {
    ledger.findLedgerEntry.mockResolvedValue(entry);

    expect(await uploads.check(USER, image)).toEqual({ ok: false, reason });
    expect(bucket.inspectUploadedObject).not.toHaveBeenCalled();
  });

  it("writes nothing when storage rejects the upload", async () => {
    bucket.inspectUploadedObject.mockResolvedValue({
      ok: false,
      reason: "too-large",
      contentType: "image/png",
      maxBytes: 10,
    });

    expect(await uploads.check(USER, image)).toMatchObject({
      reason: "too-large",
    });
    expect(bucket.delete).not.toHaveBeenCalled();
    expect(ledger.forgetObjects).not.toHaveBeenCalled();
  });
});

describe("uploads.confirm", () => {
  it("confirms within the same window the check used", async () => {
    const write = vi.fn();
    ledger.confirmUpload.mockResolvedValue(true);

    expect(await uploads.confirm(USER, image, write)).toBe(true);
    expect(ledger.confirmUpload).toHaveBeenCalledWith(
      { userId: USER, ...image },
      WINDOW_MS,
      write,
    );
  });
});

describe("uploads.deleteObjects", () => {
  it("deletes from storage, then forgets", async () => {
    await uploads.deleteObjects(USER, [image]);

    expect(bucket.delete).toHaveBeenCalledWith(USER, [image]);
    expect(ledger.forgetObjects).toHaveBeenCalledWith(USER, [image], undefined);
    expect(bucket.delete.mock.invocationCallOrder[0]).toBeLessThan(
      ledger.forgetObjects.mock.invocationCallOrder[0],
    );
  });

  it("keeps the record when storage fails, for the sweep", async () => {
    bucket.delete.mockRejectedValue(new Error("storage down"));

    await expect(uploads.deleteObjects(USER, [image])).rejects.toThrow(
      "storage down",
    );
    expect(ledger.forgetObjects).not.toHaveBeenCalled();
  });

  it("does nothing for an empty list", async () => {
    await uploads.deleteObjects(USER, []);

    expect(bucket.delete).not.toHaveBeenCalled();
  });
});
