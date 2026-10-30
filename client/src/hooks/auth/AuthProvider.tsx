import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  authGuestEndpoint,
  authLogoutEndpoint,
  authMeEndpoint,
} from "../../config";
import {
  onSessionChange,
  parseSession,
  refreshSession,
  type Session,
} from "../../api/session";
import { AuthContext, type AuthUser } from "./context";

/**
 * How long before the access token expires it's refreshed, so requests don't
 * find it expired. A request that still does, after the tab slept through
 * the timer for instance, refreshes on its 401 instead.
 */
const REFRESH_AHEAD_MS = 60_000;

async function fetchSession(): Promise<Session | null> {
  const res = await fetch(authMeEndpoint(), { credentials: "include" });
  // The access token has usually expired since the last visit.
  if (res.status === 401) return refreshSession();
  if (!res.ok) throw new Error("Failed to load session");
  return parseSession(await res.json());
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSession(await fetchSession());
    } catch {
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    await fetch(authLogoutEndpoint(), {
      method: "POST",
      credentials: "include",
    });
    setSession(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A refresh started anywhere, by a request's 401 or the timer below,
  // moves the session on, or ends it.
  useEffect(() => onSessionChange(setSession), []);

  useEffect(() => {
    // A guest's session has nothing to refresh it with, and its month is
    // past what setTimeout can wait: the timer would fire at once.
    if (!session || session.isGuest) return;
    const timer = setTimeout(
      () => {
        // A failure leaves the next request's 401 to refresh.
        refreshSession().catch(() => undefined);
      },
      Math.max(0, session.expiresAt - Date.now() - REFRESH_AHEAD_MS),
    );
    return () => clearTimeout(timer);
  }, [session]);

  // Only a different user is a new user: a refresh keeps the same object.
  const continueAsGuest = useCallback(async () => {
    const res = await fetch(authGuestEndpoint(), {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) throw new Error("Couldn't start a guest chat");
    setSession(parseSession(await res.json()));
  }, []);

  // Only a different user is a new user: a refresh keeps the same object.
  const userId = session?.userId;
  const isGuest = session?.isGuest ?? false;
  const user = useMemo<AuthUser | null>(
    () => (userId ? { userId, isGuest } : null),
    [userId, isGuest],
  );

  return (
    <AuthContext.Provider
      value={{ user, loading, refresh, signOut, continueAsGuest }}
    >
      {children}
    </AuthContext.Provider>
  );
}
