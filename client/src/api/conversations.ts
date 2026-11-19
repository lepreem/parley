import type {
  Conversation,
  ConversationsResponse,
  CreateProjectConversationBody,
  MoveConversationBody,
  RenameConversationBody,
} from "@parley/contract";
import { apiFetch, apiJson, jsonRequest } from "./http";
import type { Server } from "./server";

export type { Conversation };

export async function fetchConversations(
  server: Server,
): Promise<Conversation[]> {
  const data = await apiJson<ConversationsResponse>(server, "/conversations");
  if (!Array.isArray(data?.conversations)) {
    throw new Error("Invalid conversations response");
  }
  return data.conversations;
}

/** A new chat, in `projectId` when it's given. */
export async function createConversation(
  server: Server,
  projectId?: string,
): Promise<Conversation> {
  if (projectId === undefined)
    return apiJson<Conversation>(server, "/conversations", { method: "POST" });
  return apiJson<Conversation>(
    server,
    "/conversations",
    jsonRequest("POST", { projectId } satisfies CreateProjectConversationBody),
  );
}

/** Into a project, or out of one with null. */
export async function moveConversation(
  server: Server,
  conversationId: string,
  projectId: string | null,
): Promise<Conversation> {
  return apiJson<Conversation>(
    server,
    `/conversations/${conversationId}/project`,
    jsonRequest("PUT", { projectId } satisfies MoveConversationBody),
  );
}

export async function renameConversation(
  server: Server,
  conversationId: string,
  title: string,
): Promise<Conversation> {
  return apiJson<Conversation>(
    server,
    `/conversations/${conversationId}`,
    jsonRequest("PATCH", {
      conversationTitle: title,
    } satisfies RenameConversationBody),
  );
}

export async function deleteConversation(
  server: Server,
  conversationId: string,
): Promise<void> {
  await apiFetch(server, `/conversations/${conversationId}`, {
    method: "DELETE",
  });
}
