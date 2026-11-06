import { Hono } from "hono";
import * as toolApprovalsController from "../controllers/toolApprovals.controller";
import {
  validateReqBody,
  validateReqParams,
} from "../middleware/validate.middleware";
import { CTX_KEYS } from "../../../core/keys";
import { conversationReqParamSchema } from "../schema/conversations.schema";
import {
  toolApprovalAnswerBodySchema,
  toolApprovalReqParamSchema,
} from "../schema/toolApprovals.schema";

export const toolApprovalsRouter = new Hono();

toolApprovalsRouter.get(
  "/",
  validateReqParams(conversationReqParamSchema),
  toolApprovalsController.handleListToolApprovals,
);

toolApprovalsRouter.post(
  `/:${CTX_KEYS.toolApprovalId}`,
  validateReqParams(toolApprovalReqParamSchema),
  validateReqBody(toolApprovalAnswerBodySchema),
  toolApprovalsController.handleAnswerToolApproval,
);
