import { useServer } from "../server/useServer";
import { useAuth } from "./useAuth";

/**
 * Whether this section is the cloud's and the user is chatting there as a
 * guest: text only, on the models a guest may use. The local server has no
 * sign-in, so no guests.
 */
export function useIsGuest(): boolean {
  const server = useServer();
  const { user } = useAuth();
  return server.signIn === "session" && !!user?.isGuest;
}
