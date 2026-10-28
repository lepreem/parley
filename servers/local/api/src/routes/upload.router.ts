import { Hono } from "hono";
import * as uploadController from "../controllers/upload.controller";
import { MAX_AUDIO_BYTES } from "../../../core/files";
import {
  validateReqBody,
  validateReqForm,
} from "../middleware/validate.middleware";
import {
  audioUploadSchema,
  youtubeUploadSchema,
} from "../schema/upload.schema";
import { imagesRouter } from "./images.router";
import { uploadLimit } from "../middleware/uploadLimit.middleware";

export const uploadRouter = new Hono();

uploadRouter.route("/image", imagesRouter);

uploadRouter.post(
  "/audio",
  uploadLimit(MAX_AUDIO_BYTES, "Audio file is too large"),
  validateReqForm(audioUploadSchema),
  uploadController.handleAudioUpload,
);
uploadRouter.post(
  "/youtube",
  validateReqBody(youtubeUploadSchema),
  uploadController.handleYoutubeUpload,
);
