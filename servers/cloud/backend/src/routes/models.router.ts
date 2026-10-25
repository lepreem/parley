import { Hono } from "hono";
import * as modelsController from "../controllers/models.controller";
import { modelRateLimiter } from "../middleware/rateLimit.middleware";
import { requireAuth, type AuthEnv } from "../middleware/auth.middleware";
import { httpCache } from "@parley/server-kit/http/cache.middleware";

export const modelsRouter = new Hono<AuthEnv>();

modelsRouter.use("*", requireAuth, modelRateLimiter);

// Revalidated every time, never served stale: the client already keeps the
// catalog for an hour, and a browser that answered from a stale copy would have
// it keep that copy for the hour too, missing whatever a deploy added to it.
// An unchanged catalog costs a 304 with no body.
modelsRouter.use("*", httpCache({ revalidate: true }));
modelsRouter.get("/chat", ...modelsController.handleGetModels);
modelsRouter.get(
  "/transcription",
  ...modelsController.handleGetTranscribeModels,
);
