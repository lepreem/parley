import { createContext } from "react";
import type { Capabilities, Tier } from "@parley/contract/tiers";

export type AuthUser = {
  userId: string;
  tier: Tier;
  capabilities: Capabilities;
};

export type AuthContextValue = {
  user: AuthUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Starts chatting without an account. Throws if the API refuses. */
  continueAsGuest: () => Promise<void>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);
