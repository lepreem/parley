import { Hono } from "hono";
import * as jobsController from "../controllers/jobs.controller";
import {
  validateReqParams,
  validateReqQuery,
} from "../middleware/validate.middleware";
import { CTX_KEYS } from "../../../core/keys";
import { jobReqParamSchema, jobsListQuerySchema } from "../schema/jobs.schema";
import { httpCache } from "@parley/server-kit/http/cache.middleware";

export const jobsRouter = new Hono();

jobsRouter.get(
  `/transcribe/:${CTX_KEYS.audioUploadId}`,
  validateReqParams(jobReqParamSchema),
  httpCache({ revalidate: true }),
  jobsController.handleGetTranscribeJob,
);

jobsRouter.delete(
  `/transcribe/:${CTX_KEYS.audioUploadId}`,
  validateReqParams(jobReqParamSchema),
  jobsController.handleDeleteTranscribeJob,
);

jobsRouter.get(
  "/",
  validateReqQuery(jobsListQuerySchema),
  jobsController.getJobs,
);
