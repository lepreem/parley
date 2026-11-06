/**
 * A server the client talks to: the cloud one, which signs in with WorkOS
 * session cookies, or the local one on the user's own machine, which has no
 * sign-in. Everything the client asks of a server goes through one of these,
 * and the ways the two differ are fixed here rather than discovered.
 */
export type Server = {
  id: "cloud" | "local";
  /** Where its API answers, without a trailing slash; empty for this page's own origin. */
  baseUrl: string;
  signIn: "session" | "none";
  /** Where its section of the app lives in the client's own routes. */
  appPath: "/chat" | "/local";
  /**
   * Whether it's up whenever the client is. The cloud is, so its failures
   * surface on the requests themselves; the local server only runs while the
   * user has it running, so the client checks for it.
   */
  alwaysOn: boolean;
  /**
   * How a file reaches it. "signed": the API mints a storage URL, the file
   * goes there, and the API confirms it (cloud). "direct": one multipart
   * request carries the file (local).
   */
  uploads: "signed" | "direct";
  /**
   * Whether a reply can stop to ask the person's approval for a tool: the local
   * server's Claude Code and Codex can.
   */
  toolApprovals: boolean;
  /**
   * The model a new chat starts on, when offered. It may be named by alias.
   */
  defaultChatModelId: string;
  /**
   * Chat models listed first in the picker, in this order, ahead of the full
   * catalog, by id or alias. Ones the catalog doesn't offer are skipped.
   */
  recommendedChatModelIds: readonly string[];
};

/**
 * A URL the server answered with, such as an image's, usable from this page:
 * a path is the server's own, so it's resolved against the server.
 */
export function serverUrl(server: Server, url: string): string {
  return url.startsWith("/") ? `${server.baseUrl}${url}` : url;
}
