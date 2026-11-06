import type { Context } from "hono";
import type { ToolApproval } from "@parley/contract";
import { CTX_KEYS } from "../../../core/keys";
import { memory } from "../memory";

/** GET /conversations/:conversationId/tool-approvals */
export function handleListToolApprovals(c: Context) {
  return c.json(
    memory.toolApprovals.pending(
      c.get(CTX_KEYS.conversationId),
    ) satisfies ToolApproval[],
  );
}

/** POST /conversations/:conversationId/tool-approvals/:toolApprovalId */
export function handleAnswerToolApproval(c: Context) {
  return memory.toolApprovals.answer(
    c.get(CTX_KEYS.conversationId),
    c.get(CTX_KEYS.toolApprovalId),
    c.get(CTX_KEYS.allow),
  )
    ? c.body(null, 204)
    : c.json({ message: "This is no longer waiting for an answer" }, 404);
}
