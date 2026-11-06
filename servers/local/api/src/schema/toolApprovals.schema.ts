import { z } from "zod";
import type { AnswerToolApprovalBody } from "@parley/contract";
import { takesBody } from "@parley/server-kit/http/takesBody";
import { CTX_KEYS } from "../../../core/keys";
import { conversationReqParamSchema } from "./conversations.schema";

export const toolApprovalReqParamSchema = conversationReqParamSchema.extend({
  [CTX_KEYS.toolApprovalId]: z.string().uuid(),
});

export const toolApprovalAnswerBodySchema = takesBody<AnswerToolApprovalBody>()(
  z.object({ [CTX_KEYS.allow]: z.boolean() }),
);
