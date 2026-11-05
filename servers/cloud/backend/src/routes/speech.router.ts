import { Hono } from "hono";
import { audioClipLimit } from "@parley/server-kit/http/audioClip";
import * as speechController from "../controllers/speech.controller";
import {
  dictationDailyRateLimiter,
  dictationRateLimiter,
} from "../middleware/rateLimit.middleware";
import {
  refuseGuests,
  requireAuth,
  type AuthEnv,
} from "../middleware/auth.middleware";

export const speechRouter = new Hono<AuthEnv>();

// In this order so nothing of a recording is read until its sender is known
// and within budget.
speechRouter.post(
  "/transcribe",
  requireAuth,
  refuseGuests,
  dictationRateLimiter,
  dictationDailyRateLimiter,
  audioClipLimit,
  ...speechController.handleDictation,
);
