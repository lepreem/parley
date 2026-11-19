import type { Server } from "../../api/server";

/**
 * Where a server's section of the app lives, and a conversation in it.
 * Conversation ids are the server's own, so a path always says which server
 * it belongs to.
 */
export function sectionPath(server: Server, conversationId?: string): string {
  return conversationId
    ? `${server.appPath}/${conversationId}`
    : server.appPath;
}

/** A project's page in a server's section. */
export function projectPath(server: Server, projectId: string): string {
  return `${server.appPath}/projects/${projectId}`;
}

/** A new chat that starts in this project once its first message is sent. */
export function newChatInProjectPath(
  server: Server,
  projectId: string,
): string {
  return `${server.appPath}?${NEW_CHAT_PROJECT_PARAM}=${encodeURIComponent(projectId)}`;
}

/** The query parameter a new chat's project rides on. */
export const NEW_CHAT_PROJECT_PARAM = "project";
