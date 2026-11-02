import { createContext } from "react";

export type AuthUser = {
  userId: string;
  isGuest: boolean;
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
