import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import type { UploadedImage } from "@parley/contract";
import { data } from "../../../core/data";
import { files } from "../../../core/files";
import { CTX_KEYS } from "../../../core/keys";
import type { UploadId } from "@parley/server-kit/ids";

/**
 * POST /upload/image — an image, dropped into the chat or uploaded from the
 * navbar, stored under an id minted here. The file is written before its row,
 * so a row never points at a missing file; a crash in between leaves a file
 * the next startup removes.
 */
export async function handleImageUpload(c: Context) {
  const file: File = c.get(CTX_KEYS.file);
  const fileName: string = c.get(CTX_KEYS.fileName);
  const imageUploadId: UploadId = randomUUID();

  await files.write(
    { kind: "image", uploadId: imageUploadId },
    new Uint8Array(await file.arrayBuffer()),
  );
  await data.images.createImageAttachment({
    imageUploadId,
    fileName,
    mimeType: file.type,
    sizeBytes: file.size,
  });

  return c.json({
    imageUploadId,
    fileName,
    size: file.size,
    mimeType: file.type,
    url: data.images.imageUrl(imageUploadId),
  } satisfies UploadedImage);
}

/**
 * GET /upload/image/:imageUploadId — the image itself. An id names one image
 * for good, so the browser may keep it as long as it likes.
 */
export async function handleGetImage(c: Context) {
  const imageUploadId: string = c.get(CTX_KEYS.imageUploadId);

  const [image] = await data.images.resolveImages([imageUploadId]);
  if (!image) return c.json({ message: "Image not found" }, 404);

  const bytes = await files.read({ kind: "image", uploadId: imageUploadId });
  return c.body(new Uint8Array(bytes), 200, {
    "Content-Type": image.mimeType,
    "Cache-Control": "private, max-age=31536000, immutable",
  });
}

/** DELETE /upload/image/:imageUploadId — delete an unlinked, unreserved image attachment. */
export async function handleDeleteImage(c: Context) {
  const imageUploadId = c.get(CTX_KEYS.imageUploadId);
  const deletedImageUploadId =
    await data.images.deleteUnlinkedUnreservedImageAttachment(imageUploadId);
  if (deletedImageUploadId) {
    await files.delete([{ kind: "image", uploadId: deletedImageUploadId }]);
  }

  return c.json({ message: "Image deleted" });
}
