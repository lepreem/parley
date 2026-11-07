import { Hono } from "hono";
import * as modelsController from "../controllers/models.controller";
import { httpCache } from "@parley/server-kit/http/cache.middleware";

export const modelsRouter = new Hono();

// The catalog changes when the person changes a program's settings, and the
// page is told to fetch it again then, so it's never served from a cache
// without asking. Unchanged, the answer is an empty 304.
modelsRouter.use("*", httpCache({ revalidate: true }));
modelsRouter.get("/chat", modelsController.handleGetModels);
