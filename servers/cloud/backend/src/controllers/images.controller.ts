import { randomUUID } from "node:crypto";
import type { UploadedImage } from "@parley/contract";
import { sign } from "../storage";
import { uploads } from "../uploads";
import { data } from "../data";
import { authed } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import {
  imageConfirmSchema,
  imageReqParamSchema,
} from "../schema/images.schema";
import { ALREADY_CONFIRMED, uploadRejection } from "../utils/uploadRejection";
import type { UploadId } from "@parley/server-kit/ids";

/**
 * POST /upload/image — a URL the browser PUTs an image to (dropped into the
 * chat, or uploaded from the navbar), straight into storage. The id is minted
 * here rather than chosen by the client.
 *
 * Only the upload's ledger record is written, so an upload that never
 * completes leaves nothing for the rest of the code to trip over; the sweep
 * removes it.
 */
export const handleImageUploadUrl = authed.createHandlers(async (c) => {
  const { userId } = c.var;

  const imageUploadId: UploadId = randomUUID();
  const signedUploadUrl = await uploads.start(userId, {
    kind: "image",
    uploadId: imageUploadId,
  });

  return c.json({ uploadId: imageUploadId, signedUploadUrl });
});

const IMAGE_WORDING = {
  noun: "image",
  wrongType: () => "File must be an image",
  tooLarge: "Image is too large",
};

/**
 * POST /upload/image/confirm — the image is in the bucket: check it, record
 * it, and return a signed URL for the preview.
 *
 * The URL is persisted, not just returned: this runs while the user is still
 * typing, so caching it here is what keeps signing off the send path entirely.
 * The upload must be pending in the ledger for this user as an image, so an
 * id minted for audio is a 404. A rejected upload is left for the sweep.
 */
export const handleImageConfirm = authed.createHandlers(
  validate("json", imageConfirmSchema),
  async (c) => {
    const { userId } = c.var;
    const { uploadId: imageUploadId, fileName } = c.req.valid("json");

    const image = { kind: "image", uploadId: imageUploadId } as const;
    const upload = await uploads.check(userId, image);
    if (!upload.ok) {
      const [body, status] = uploadRejection(upload, IMAGE_WORDING);
      return c.json(body, status);
    }

    const signedUrl = await sign.url(userId, image);
    const confirmed = await uploads.confirm(userId, image, (executor) =>
      data.images.createImageAttachment(
        {
          userId,
          imageUploadId,
          fileName,
          mimeType: upload.contentType,
          sizeBytes: upload.sizeBytes,
          signedUrl,
        },
        executor,
      ),
    );
    if (!confirmed) {
      return c.json({ message: ALREADY_CONFIRMED }, 409);
    }

    return c.json({
      imageUploadId,
      fileName,
      size: upload.sizeBytes,
      mimeType: upload.contentType,
      url: signedUrl,
    } satisfies UploadedImage);
  },
);

/**
 * GET /upload/image/:imageUploadId — the image itself, by a redirect to its
 * signed URL, as the local server serves the file at the same path. The
 * signature is cached; it's only re-signed once that nears expiry.
 */
export const handleGetImage = authed.createHandlers(
  validate("param", imageReqParamSchema),
  async (c) => {
    const { userId } = c.var;
    const { imageUploadId } = c.req.valid("param");

    const [image] = await data.images.resolveImages(userId, [imageUploadId]);

    if (!image) return c.json({ message: "Image not found" }, 404);

    return c.redirect(image.url, 302);
  },
);

/** DELETE /upload/image/:imageUploadId — delete an unlinked, unreserved image attachment. */
export const handleDeleteImage = authed.createHandlers(
  validate("param", imageReqParamSchema),
  async (c) => {
    const { userId } = c.var;
    const { imageUploadId } = c.req.valid("param");
    const deletedImageUploadId =
      await data.images.deleteOwnedUnlinkedUnreservedImageAttachment(
        userId,
        imageUploadId,
      );
    if (deletedImageUploadId) {
      await uploads.deleteObjects(userId, [
        { kind: "image", uploadId: deletedImageUploadId },
      ]);
    }

    return c.json({ message: "Image deleted" });
  },
);
