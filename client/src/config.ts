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

/**
 * Whether this page can use the local server: the desktop app's own page, or
 * Vite in development. The hosted site can't, and offers the app instead.
 */
export const canReachLocalServer = servedByLocalServer || import.meta.env.DEV;

/**
 * The server on the user's own machine, which chats through their Claude Code
 * or Codex.
 */
export const localServer: Server = {
  id: "local",
  baseUrl: servedByLocalServer ? "" : `http://${DEV_HOST}:${LOCAL_PORT}`,
  signIn: "none",
  appPath: "/local",
  alwaysOn: false,
  uploads: "direct",
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
