import { Hono } from "hono";
import * as imagesController from "../controllers/images.controller";
import {
  imageReadRateLimiter,
  uploadConfirmRateLimiter,
  uploadRateLimiter,
} from "../middleware/rateLimit.middleware";
import {
  refuseGuests,
  requireAuth,
  type AuthEnv,
} from "../middleware/auth.middleware";

/**
 * Mounted under /upload/image, ahead of the parent's middleware, so nothing
 * here is reached by it: auth and every budget are declared below. That's the
 * point — minting a URL stands for an upload and spends that budget, confirming
 * has the confirm budget, and reading an image back re-signs at most once a
 * week, so it gets a read-sized budget instead.
 */
export const imagesRouter = new Hono<AuthEnv>();

imagesRouter.use("*", requireAuth, refuseGuests);

imagesRouter.post(
  "/",
  uploadRateLimiter,
  ...imagesController.handleImageUploadUrl,
);

imagesRouter.post(
  "/confirm",
  uploadConfirmRateLimiter,
  ...imagesController.handleImageConfirm,
);

imagesRouter.get(
  "/:imageUploadId",
  imageReadRateLimiter,
  ...imagesController.handleGetImage,
);

imagesRouter.delete(
  "/:imageUploadId",
  imageReadRateLimiter,
  ...imagesController.handleDeleteImage,
);
