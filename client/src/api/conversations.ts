import type {
  Conversation,
  ConversationsResponse,
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

export async function createConversation(
  server: Server,
): Promise<Conversation> {
  return apiJson<Conversation>(server, "/conversations", { method: "POST" });
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
