import type { Server } from "./api/server";

/** Dev host — keep API + WebSocket on the same hostname so session cookies are sent. */
const DEV_HOST = "localhost";

/**
 * The hosted server. Its session cookies are set on this host. A production
 * build is served by the cloud API itself, so by default it calls its own
 * origin: the empty string. In development Vite serves the client, and the
 * API is on its own port.
 */
export const cloudServer: Server = {
  id: "cloud",
  baseUrl: (
    import.meta.env.VITE_API_URL ??
    (import.meta.env.DEV ? `http://${DEV_HOST}:3001` : "")
  ).replace(/\/$/, ""),
  signIn: "session",
  appPath: "/chat",
  alwaysOn: true,
  uploads: "signed",
  defaultChatModelId: "openai/gpt-4o-mini",
  defaultTranscribeModelId: "nova-3-general",
  // OpenRouter's "~…-latest" ids follow each family's newest model, so this
  // list doesn't go stale as models are released.
  recommendedChatModelIds: [
    "openai/gpt-4o-mini",
    "~anthropic/claude-sonnet-latest",
    "~anthropic/claude-haiku-latest",
    "~google/gemini-pro-latest",
    "~google/gemini-flash-latest",
    "~openai/gpt-mini-latest",
    "~deepseek/deepseek-flash-latest",
  ],
};

const LOCAL_PORT = "3002";

/**
 * Whether the local server itself served this page, as it does for someone
 * using only this computer, or their phone over Tailscale. Its API is then
 * this page's own origin, and the cloud isn't reachable from here. The server
 * marks the page, since a phone reaches it by another name and port.
 */
export const servedByLocalServer =
  document
    .querySelector('meta[name="parley-server"]')
    ?.getAttribute("content") === "local";

/** The server on the user's own machine, which chats through their Claude Code. */
export const localServer: Server = {
  id: "local",
  baseUrl: servedByLocalServer
    ? ""
    : (
        import.meta.env.VITE_LOCAL_API_URL ?? `http://${DEV_HOST}:${LOCAL_PORT}`
      ).replace(/\/$/, ""),
  signIn: "none",
  appPath: "/local",
  alwaysOn: false,
  uploads: "direct",
  defaultChatModelId: "sonnet",
  defaultTranscribeModelId: "small",
  // Its catalog is a handful of Claude models already.
  recommendedChatModelIds: [],
};

export function authLoginUrl(): string {
  return `${cloudServer.baseUrl}/auth/login`;
}

export function authMeEndpoint(): string {
  return `${cloudServer.baseUrl}/auth/me`;
}

export function authRefreshEndpoint(): string {
  return `${cloudServer.baseUrl}/auth/refresh`;
}

export function authGuestEndpoint(): string {
  return `${cloudServer.baseUrl}/auth/guest`;
}

export function authLogoutEndpoint(): string {
  return `${cloudServer.baseUrl}/auth/logout`;
}
