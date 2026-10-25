import { Hono } from "hono";
import * as imagesController from "../controllers/images.controller";
import { CTX_KEYS } from "../../../core/keys";
import { MAX_IMAGE_BYTES } from "../../../core/files";
import {
  validateReqForm,
  validateReqParams,
} from "../middleware/validate.middleware";
import {
  imageReqParamSchema,
  imageUploadSchema,
} from "../schema/images.schema";
import { uploadLimit } from "../middleware/uploadLimit.middleware";

/** Mounted under /upload/image. */
export const imagesRouter = new Hono();

imagesRouter.post(
  "/",
  uploadLimit(MAX_IMAGE_BYTES, "Image is too large"),
  validateReqForm(imageUploadSchema),
  imagesController.handleImageUpload,
);

imagesRouter.get(
  `/:${CTX_KEYS.imageUploadId}`,
  validateReqParams(imageReqParamSchema),
  imagesController.handleGetImage,
);

imagesRouter.delete(
  `/:${CTX_KEYS.imageUploadId}`,
  validateReqParams(imageReqParamSchema),
  imagesController.handleDeleteImage,
);
