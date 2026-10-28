import { z } from "zod";
import { CTX_KEYS } from "../../../core/keys";
import { jobStatuses } from "../../../core/db";

export const jobReqParamSchema = z.object({
  [CTX_KEYS.audioUploadId]: z.string().uuid(),
});

export type JobStatus = (typeof jobStatuses)[number];

/** Query params for the paginated history list (GET /jobs). */
export const jobsListQuerySchema = z.object({
  [CTX_KEYS.limit]: z.coerce.number().int().min(1).max(100).optional(),
  [CTX_KEYS.cursor]: z.string().min(1).optional(),
  [CTX_KEYS.status]: z.enum(jobStatuses).optional(),
  [CTX_KEYS.q]: z.string().trim().min(1).optional(),
});

export const jobCursorSchema = z.object({
  createdAt: z.string(),
  audioUploadId: z.string(),
});
