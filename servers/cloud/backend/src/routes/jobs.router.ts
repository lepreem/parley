import { Hono } from "hono";
import * as jobsController from "../controllers/jobs.controller";
import { jobRateLimiter } from "../middleware/rateLimit.middleware";
import { requireAuth, type AuthEnv } from "../middleware/auth.middleware";
import { httpCache } from "@parley/server-kit/http/cache.middleware";

export const jobsRouter = new Hono<AuthEnv>();

jobsRouter.use("*", requireAuth, jobRateLimiter);

jobsRouter.get(
  "/transcribe/:audioUploadId",
  httpCache({ revalidate: true }),
  ...jobsController.handleGetTranscribeJob,
);

jobsRouter.delete(
  "/transcribe/:audioUploadId",
  ...jobsController.handleDeleteTranscribeJob,
);

jobsRouter.get("/", ...jobsController.handleListJobs);
