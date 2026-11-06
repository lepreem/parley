import type {
  AnswerToolApprovalBody,
  PermissionMode,
  ToolApproval,
  ToolApprovalChoice,
} from "@parley/contract";
import { apiFetch, apiJson, jsonRequest } from "./http";
import type { Server } from "./server";

export type { PermissionMode, ToolApproval, ToolApprovalChoice };

export function fetchToolApprovals(
  server: Server,
  conversationId: string,
): Promise<ToolApproval[]> {
  return apiJson<ToolApproval[]>(
    server,
    `/conversations/${conversationId}/tool-approvals`,
  );
}

export async function answerToolApproval(
  server: Server,
  conversationId: string,
  id: string,
  answer: ToolApprovalChoice,
): Promise<void> {
  await apiFetch(
    server,
    `/conversations/${conversationId}/tool-approvals/${id}`,
    jsonRequest("POST", { answer } satisfies AnswerToolApprovalBody),
  );
}
