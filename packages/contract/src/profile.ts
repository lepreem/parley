import type { Avatar } from "./avatars";

/**
 * The name a person picks to show as themselves. It isn't unique and isn't
 * used to sign in: it's only what the app calls them. Nothing fills it in for
 * them, not even the name on their sign-in account.
 */
export const USERNAME_MAX_LENGTH = 32;

/** GET /profile, and what PATCH /profile answers. */
export type ProfileResponse = {
  avatar: Avatar;
  /** Null until they pick one. */
  username: string | null;
};

/**
 * PATCH /profile: whichever of the two is changing. A null username clears
 * it.
 */
export type UpdateProfileBody = {
  avatar?: Avatar;
  username?: string | null;
};

/**
 * A username as it's saved: trimmed, with runs of spaces closed up, or null
 * when nothing's left.
 */
export function normalizeUsername(name: string): string | null {
  const tidy = name.trim().replace(/\s+/g, " ");
  return tidy === "" ? null : tidy;
}
