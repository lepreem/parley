import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/db", async () =>
  (await import("../helpers/inMemoryDb")).inMemoryDbModule(),
);

// Small limits, so the oversized bodies below are kilobytes, not megabytes.
vi.mock("../../core/files", async (importActual) => ({
  ...(await importActual<typeof import("../../core/files")>()),
  MAX_IMAGE_BYTES: 1024,
}));

import {
  Attachments,
  ChatMessageAttachmentLinks,
  ChatMessages,
  Conversations,
  db,
} from "../../core/db";
import { files, MAX_IMAGE_BYTES } from "../../core/files";
import { createApp } from "../../api/app";
import { originHeaders } from "../helpers/headers";
import { deleteAllRows } from "../helpers/inMemoryDb";

const PIXELS = new TextEncoder().encode("pixels");

async function uploadImage(file?: File) {
  const form = new FormData();
  if (file) form.append("file", file);
  return (await createApp()).request("http://localhost/upload/image", {
    method: "POST",
    headers: originHeaders(),
    body: form,
  });
}

/** An image uploaded through the route, as its id. */
async function uploadedImage() {
  const res = await uploadImage(
    new File([PIXELS], "diagram.png", { type: "image/png" }),
  );
  return ((await res.json()) as { imageUploadId: string }).imageUploadId;
}

function imageRequest(imageUploadId: string, method = "GET") {
  return createApp().then((app) =>
    app.request(`http://localhost/upload/image/${imageUploadId}`, {
      method,
      headers: originHeaders(),
    }),
  );
}

beforeEach(async () => {
  await deleteAllRows(db);
});

describe("POST /upload/image", () => {
  it("stores the image and its row, under a fresh id", async () => {
    const res = await uploadImage(
      new File([PIXELS], "diagram.png", { type: "image/png" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { imageUploadId: string };
    expect(body).toEqual({
      imageUploadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      fileName: "diagram.png",
      size: PIXELS.length,
      mimeType: "image/png",
      url: `/upload/image/${body.imageUploadId}`,
    });
    expect(
      await files.read({ kind: "image", uploadId: body.imageUploadId }),
    ).toEqual(Buffer.from(PIXELS));
    expect(await db.select().from(Attachments)).toEqual([
      expect.objectContaining({
        attachmentId: body.imageUploadId,
        kind: "image",
        fileName: "diagram.png",
        mimeType: "image/png",
        sizeBytes: PIXELS.length,
      }),
    ]);
  });

  it.each([
    ["no file", undefined, "A file is required"],
    [
      "something that isn't an image",
      new File([PIXELS], "notes.txt", { type: "text/plain" }),
      "File must be an image",
    ],
    [
      "an empty file",
      new File([], "empty.png", { type: "image/png" }),
      "The file is empty",
    ],
    [
      "an image over the limit",
      new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "huge.png", {
        type: "image/png",
      }),
      "Image is too large",
    ],
  ])("refuses %s, storing nothing", async (_case, file, message) => {
    const res = await uploadImage(file);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message });
    expect(await db.select().from(Attachments)).toEqual([]);
  });

  it("refuses a body far over the limit without reading it", async () => {
    const res = await uploadImage(
      // Past the limit and the room left for the rest of the form.
      new File([new Uint8Array(MAX_IMAGE_BYTES + 128 * 1024)], "huge.png", {
        type: "image/png",
      }),
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ message: "Image is too large" });
  });
});

describe("GET /upload/image/:imageUploadId", () => {
  it("answers the image itself, cacheable for good", async () => {
    const imageUploadId = await uploadedImage();

    const res = await imageRequest(imageUploadId);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PIXELS);
  });

  it("returns 404 for an id with no image", async () => {
    expect((await imageRequest(randomUUID())).status).toBe(404);
  });

  it("returns 400 for an id that isn't a uuid", async () => {
    expect((await imageRequest("not-a-uuid")).status).toBe(400);
  });
});

describe("DELETE /upload/image/:imageUploadId", () => {
  it("deletes an unlinked, unreserved image, then its file", async () => {
    const imageUploadId = await uploadedImage();

    const res = await imageRequest(imageUploadId, "DELETE");

    expect(res.status).toBe(200);
    expect(await db.select().from(Attachments)).toEqual([]);
    await expect(
      files.read({ kind: "image", uploadId: imageUploadId }),
    ).rejects.toThrow();
  });

  it("keeps an image a message carries, and its file", async () => {
    const imageUploadId = await uploadedImage();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await db.insert(Conversations).values({ id: conversationId });
    await db.insert(ChatMessages).values({
      id: messageId,
      conversationId,
      role: "user",
      content: "Look",
    });
    await db.insert(ChatMessageAttachmentLinks).values({
      messageId,
      attachmentId: imageUploadId,
      position: 0,
    });

    const res = await imageRequest(imageUploadId, "DELETE");

    expect(res.status).toBe(200);
    expect(await db.select().from(Attachments)).toHaveLength(1);
    expect(
      await files.read({ kind: "image", uploadId: imageUploadId }),
    ).toEqual(Buffer.from(PIXELS));
  });

  it("returns 400 for an id that isn't a uuid", async () => {
    expect((await imageRequest("not-a-uuid", "DELETE")).status).toBe(400);
  });
});
