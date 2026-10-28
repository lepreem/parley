import { z } from "zod";
import { CTX_KEYS, FORM_KEYS } from "../../../core/keys";
import { MAX_IMAGE_BYTES } from "../../../core/files";
import { displayName, uploadedFileField } from "./upload.schema";

/** POST /upload/image — an image to store, for a message to carry. */
export const imageUploadSchema = z
  .object({
    [FORM_KEYS.file]: uploadedFileField({
      typePrefix: "image/",
      maxBytes: MAX_IMAGE_BYTES,
      wrongType: () => "File must be an image",
      tooLarge: "Image is too large",
    }),
  })
  .transform((data) => ({
    [CTX_KEYS.file]: data[FORM_KEYS.file],
    [CTX_KEYS.fileName]: displayName(data[FORM_KEYS.file], "image"),
  }));

/** Identifies an uploaded image for read or deletion. */
export const imageReqParamSchema = z.object({
  [CTX_KEYS.imageUploadId]: z.string().uuid(),
});
