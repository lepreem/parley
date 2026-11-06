import type { AnswerToolApprovalBody, ToolApproval } from "@parley/contract";
import { apiFetch, apiJson, jsonRequest } from "./http";
import type { Server } from "./server";

export type { ToolApproval };

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
  allow: boolean,
): Promise<void> {
  await apiFetch(
    server,
    `/conversations/${conversationId}/tool-approvals/${id}`,
    jsonRequest("POST", { allow } satisfies AnswerToolApprovalBody),
  );
}
