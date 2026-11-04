import { Hono } from "hono";
import {
  audioClipBody,
  audioClipLimit,
} from "@parley/server-kit/http/audioClip";
import * as speechController from "../controllers/speech.controller";

export const speechRouter = new Hono();

speechRouter.post(
  "/transcribe",
  audioClipLimit,
  audioClipBody,
  speechController.handleDictation,
);
