import { authRefreshEndpoint } from "../config";

/**
 * The signed-in session as the API reports it: who, and when the access
 * token in the session cookie expires. The cookies themselves are HttpOnly,
 * so this is the only way the client learns either.
 */
export type Session = {
  userId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /**
   * Chatting without an account. A guest's session isn't refreshed: it ends
   * when it expires, or when they sign in and their chats move to the account.
   */
  isGuest: boolean;
};

/**
 * Reads `{ userId, expiresAt, isGuest }` as /auth/me, /auth/guest and
 * /auth/refresh answer it.
 */
export function parseSession(data: unknown): Session {
  if (data && typeof data === "object") {
    const { userId, expiresAt, isGuest } = data as Record<string, unknown>;
    const expiresAtMs =
      typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
    if (typeof userId === "string" && Number.isFinite(expiresAtMs)) {
      return { userId, expiresAt: expiresAtMs, isGuest: isGuest === true };
    }
  }
  throw new Error("Invalid session response");
}

type SessionListener = (session: Session | null) => void;

const listeners = new Set<SessionListener>();
let refreshing: Promise<Session | null> | undefined;

/** Hears every refresh's outcome: the new session, or null once it's over. */
export function onSessionChange(listener: SessionListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function requestRefresh(): Promise<Session | null> {
  const response = await fetch(authRefreshEndpoint(), {
    method: "POST",
    credentials: "include",
  });
  if (response.status === 401) {
    listeners.forEach((listener) => listener(null));
    return null;
  }
  if (!response.ok) throw new Error("Failed to refresh the session");

  const session = parseSession(await response.json());
  listeners.forEach((listener) => listener(session));
  return session;
}

/**
 * Trades the refresh cookie for a new access token. Resolves to the new
 * session, or null when the session is over and the user has to sign in
 * again; throws when the API couldn't be reached or answered otherwise.
 *
 * The API spends the refresh token, so callers that ask at once share one
 * request rather than each spending it.
 */
export function refreshSession(): Promise<Session | null> {
  refreshing ??= requestRefresh().finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}
