import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockDeleteOwnedUnlinkedUnreservedImageAttachment,
  mockResolveImages,
  mockInsert,
  mockValues,
  mockCreateUploadUrl,
  mockInspectUploadedObject,
  mockCreateSignedUrl,
  mockDeleteFromBucket,
  ledger,
} = vi.hoisted(() => ({
  mockDeleteOwnedUnlinkedUnreservedImageAttachment: vi.fn(),
  mockResolveImages: vi.fn(),
  mockInsert: vi.fn(),
  mockValues: vi.fn(),
  mockCreateUploadUrl: vi.fn(),
  mockInspectUploadedObject: vi.fn(),
  mockCreateSignedUrl: vi.fn(),
  mockDeleteFromBucket: vi.fn(),
  ledger: {
    recordPendingUpload: vi.fn(),
    findLedgerEntry: vi.fn(),
    claim: vi.fn(),
    forgetObjects: vi.fn(),
  },
}));

vi.mock("../../src/db", async () => ({
  db: { insert: mockInsert },
  ...(await import("../helpers/dbTableStubs")).tableStubs,
}));

// The ledger's SQL is covered by the integration tests. A confirm that goes
// through runs its write against the insert mock.
vi.mock("../../src/data/storageLedger.data", () => ({
  recordPendingUpload: ledger.recordPendingUpload,
  findLedgerEntry: ledger.findLedgerEntry,
  forgetObjects: ledger.forgetObjects,
  confirmUpload: async (
    entry: unknown,
    withinMs: number,
    write: (executor: unknown) => Promise<unknown>,
  ) => {
    if (!(await ledger.claim(entry, withinMs))) return false;
    await write({ insert: mockInsert });
    return true;
  },
}));

vi.mock("../../src/storage/bucket", () => ({
  // Literals: vi.mock factories run before this module's own bindings exist.
  AUDIO_BUCKET: "Audio",
  MAX_AUDIO_BYTES: 50 * 1024 * 1024,
  createUploadUrl: mockCreateUploadUrl,
  inspectUploadedObject: mockInspectUploadedObject,
  delete: mockDeleteFromBucket,
}));

vi.mock("../../src/storage/sign", () => ({
  IMAGE_URL_TTL_SECONDS: 7 * 24 * 60 * 60,
  url: mockCreateSignedUrl,
  urls: vi.fn(),
}));

vi.mock("../../src/data/images.data", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/data/images.data")>();
  return {
    ...actual,
    deleteOwnedUnlinkedUnreservedImageAttachment:
      mockDeleteOwnedUnlinkedUnreservedImageAttachment,
    resolveImages: mockResolveImages,
  };
});

import { createApp } from "../../src/app";
import { authedHeaders, sessionCookieHeader } from "../helpers/session";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const imageUploadId = "550e8400-e29b-41d4-a716-446655440000";

async function deleteImage(userId = "user_01OWNER") {
  return (await createApp()).request(
    `http://localhost/upload/image/${imageUploadId}`,
    {
      method: "DELETE",
      headers: await authedHeaders(userId),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeleteOwnedUnlinkedUnreservedImageAttachment.mockResolvedValue(null);
});

describe("GET /upload/image/:imageUploadId", () => {
  async function getImage() {
    return (await createApp()).request(
      `http://localhost/upload/image/${imageUploadId}`,
      { headers: { Cookie: await sessionCookieHeader("user_01OWNER") } },
    );
  }

  it("redirects to the image's signed URL", async () => {
    mockResolveImages.mockResolvedValue([
      {
        imageUploadId,
        fileName: "shot.png",
        mimeType: "image/png",
        size: 4096,
        url: "https://storage.test/read",
      },
    ]);

    const res = await getImage();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://storage.test/read");
    expect(mockResolveImages).toHaveBeenCalledWith("user_01OWNER", [
      imageUploadId,
    ]);
  });

  it("returns 404 for an image the user doesn't have", async () => {
    mockResolveImages.mockResolvedValue([]);

    const res = await getImage();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "Image not found" });
  });
});

describe("DELETE /upload/image/:imageUploadId", () => {
  it("deletes an owned, unlinked, unreserved image attachment, then its object", async () => {
    mockDeleteOwnedUnlinkedUnreservedImageAttachment.mockResolvedValueOnce(
      imageUploadId,
    );

    const response = await deleteImage();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "Image deleted" });
    expect(
      mockDeleteOwnedUnlinkedUnreservedImageAttachment,
    ).toHaveBeenCalledWith("user_01OWNER", imageUploadId);
    const image = { kind: "image", uploadId: imageUploadId };
    expect(mockDeleteFromBucket).toHaveBeenCalledWith("user_01OWNER", [image]);
    expect(ledger.forgetObjects).toHaveBeenCalledWith(
      "user_01OWNER",
      [image],
      undefined,
    );
  });

  it("leaves storage alone when no image was deleted", async () => {
    const response = await deleteImage();

    expect(response.status).toBe(200);
    expect(mockDeleteFromBucket).not.toHaveBeenCalled();
  });

  it("rejects an invalid upload id", async () => {
    const response = await (
      await createApp()
    ).request("http://localhost/upload/image/not-a-uuid", {
      method: "DELETE",
      headers: await authedHeaders("user_01OWNER"),
    });

    expect(response.status).toBe(400);
    expect(
      mockDeleteOwnedUnlinkedUnreservedImageAttachment,
    ).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const response = await (
      await createApp()
    ).request(`http://localhost/upload/image/${imageUploadId}`, {
      method: "DELETE",
      headers: { Origin: process.env.CLIENT_URL! },
    });

    expect(response.status).toBe(401);
    expect(
      mockDeleteOwnedUnlinkedUnreservedImageAttachment,
    ).not.toHaveBeenCalled();
  });

  it("reports deletion failures", async () => {
    mockDeleteOwnedUnlinkedUnreservedImageAttachment.mockRejectedValueOnce(
      new Error("storage unavailable"),
    );

    const response = await deleteImage();

    expect(response.status).toBe(500);
  });
});

async function postJson(path: string, body: unknown) {
  return (await createApp()).request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: await sessionCookieHeader("user_01"),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /upload/image", () => {
  beforeEach(() => {
    mockCreateUploadUrl.mockResolvedValue("https://storage.test/upload");
    ledger.recordPendingUpload.mockResolvedValue(undefined);
  });

  it("returns 401 without a session cookie", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/upload/image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(401);
    expect(mockCreateUploadUrl).not.toHaveBeenCalled();
  });

  it("records a pending upload and returns a URL bound to a fresh id", async () => {
    const res = await postJson("/upload/image", {});

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      uploadId: string;
      signedUploadUrl: string;
    };
    expect(body.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.signedUploadUrl).toBe("https://storage.test/upload");
    expect(mockCreateUploadUrl).toHaveBeenCalledWith("user_01", {
      kind: "image",
      uploadId: body.uploadId,
    });
    expect(ledger.recordPendingUpload).toHaveBeenCalledWith({
      userId: "user_01",
      kind: "image",
      uploadId: body.uploadId,
    });
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe("POST /upload/image/confirm", () => {
  const confirmBody = { uploadId: imageUploadId, fileName: "shot.png" };

  beforeEach(() => {
    ledger.findLedgerEntry.mockResolvedValue({
      status: "pending",
      createdAt: new Date(),
    });
    ledger.claim.mockResolvedValue(true);
    mockValues.mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values: mockValues });
    mockCreateSignedUrl.mockResolvedValue("https://storage.test/read");
    mockInspectUploadedObject.mockResolvedValue({
      ok: true,
      sizeBytes: 4096,
      contentType: "image/png",
    });
  });

  it("returns 401 without a session cookie", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/upload/image/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(confirmBody),
    });

    expect(res.status).toBe(401);
    expect(mockInspectUploadedObject).not.toHaveBeenCalled();
  });

  it("returns 400 for an id that is not a uuid", async () => {
    const res = await postJson("/upload/image/confirm", {
      ...confirmBody,
      uploadId: "not-a-uuid",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: "Invalid upload id" });
    expect(mockInspectUploadedObject).not.toHaveBeenCalled();
  });

  // Includes an id minted for audio: its record has the other kind.
  it("returns 404 for an id with no image upload recorded", async () => {
    ledger.findLedgerEntry.mockResolvedValue(undefined);

    const res = await postJson("/upload/image/confirm", confirmBody);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      message: "No uploaded image to confirm",
    });
    expect(ledger.findLedgerEntry).toHaveBeenCalledWith({
      userId: "user_01",
      kind: "image",
      uploadId: imageUploadId,
    });
    expect(mockInspectUploadedObject).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns 409 for an image already confirmed", async () => {
    ledger.findLedgerEntry.mockResolvedValue({
      status: "confirmed",
      createdAt: new Date(),
    });

    const res = await postJson("/upload/image/confirm", confirmBody);

    expect(res.status).toBe(409);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns 410 for an upload handed out longer ago than the window", async () => {
    ledger.findLedgerEntry.mockResolvedValue({
      status: "pending",
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000 - 1000),
    });

    const res = await postJson("/upload/image/confirm", confirmBody);

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      message: "This upload has expired; upload the file again",
    });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns 400 when storage holds something other than an image", async () => {
    mockInspectUploadedObject.mockResolvedValue({
      ok: false,
      reason: "wrong-type",
      contentType: "audio/webm",
    });

    const res = await postJson("/upload/image/confirm", confirmBody);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: "File must be an image" });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns 413 when the stored image is over the cap", async () => {
    mockInspectUploadedObject.mockResolvedValue({
      ok: false,
      reason: "too-large",
      contentType: "image/png",
      maxBytes: MAX_IMAGE_BYTES,
    });

    const res = await postJson("/upload/image/confirm", confirmBody);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      message: "Image is too large",
      maxBytes: MAX_IMAGE_BYTES,
    });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("confirms the upload with its row, recording the stored size and type and the signed URL it returns", async () => {
    const res = await postJson("/upload/image/confirm", confirmBody);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      imageUploadId,
      fileName: "shot.png",
      size: 4096,
      mimeType: "image/png",
      url: "https://storage.test/read",
    });
    expect(mockInspectUploadedObject).toHaveBeenCalledWith("user_01", {
      kind: "image",
      uploadId: imageUploadId,
    });
    expect(ledger.claim).toHaveBeenCalledWith(
      { userId: "user_01", kind: "image", uploadId: imageUploadId },
      2 * 60 * 60 * 1000,
    );
    expect(mockCreateSignedUrl).toHaveBeenCalledWith("user_01", {
      kind: "image",
      uploadId: imageUploadId,
    });
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentId: imageUploadId,
        kind: "image",
        userId: "user_01",
        fileName: "shot.png",
        mimeType: "image/png",
        sizeBytes: 4096,
        signedUrl: "https://storage.test/read",
        signedUrlExpiresAt: expect.any(Date),
      }),
    );
  });

  it("returns 409 when another confirm got there first", async () => {
    ledger.claim.mockResolvedValue(false);

    const res = await postJson("/upload/image/confirm", confirmBody);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      message: "This upload was already confirmed",
    });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("fails loudly when the row can't be written", async () => {
    mockValues.mockRejectedValueOnce(new Error("connection reset"));

    const res = await postJson("/upload/image/confirm", confirmBody);

    expect(res.status).toBe(500);
  });
});
