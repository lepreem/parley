import { Hono } from "hono";
import * as modelsController from "../controllers/models.controller";
import { httpCache } from "@parley/server-kit/http/cache.middleware";

export const modelsRouter = new Hono();

modelsRouter.use(
  "*",
  httpCache({
    maxAgeSeconds: 300,
    staleWhileRevalidateSeconds: 86_400,
  }),
);
modelsRouter.get("/chat", modelsController.handleGetModels);
modelsRouter.get("/transcription", modelsController.handleGetTranscribeModels);
