import {
  CAPABILITIES,
  TIERS,
  UNLIMITED,
  type Capabilities,
  type Tier,
} from "@parley/contract/tiers";
import { useServer } from "../server/useServer";
import { useAuth } from "./useAuth";

/**
 * The signed-in user's tier in this section, or null for a server with no
 * sign-in: the one on this computer, which has no tiers.
 */
export function useTier(): Tier | null {
  const server = useServer();
  const { user } = useAuth();
  if (server.signIn === "none") return null;
  return user?.tier ?? TIERS[0];
}

/**
 * What the user can do in this section, as the server said with their
 * session. The server refuses the rest, so this only decides what to offer.
 * Before there's a session, the least a tier gets.
 */
export function useCapabilities(): Readonly<Capabilities> {
  const server = useServer();
  const { user } = useAuth();
  if (server.signIn === "none") return UNLIMITED;
  return user?.capabilities ?? CAPABILITIES[TIERS[0]];
}
