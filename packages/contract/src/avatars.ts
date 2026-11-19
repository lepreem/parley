/**
 * A person's picture: a glyph on a coloured disc, each picked from the lists
 * below. Only the ids cross the wire; what they look like is the client's
 * (client/src/components/avatar/avatarArt.tsx), so either list can be
 * redrawn without touching a stored row.
 *
 * Adding an id is safe. Removing one turns everyone who picked it back into
 * their default, since a stored id the server no longer knows reads as unset.
 */

export const AVATAR_GLYPHS = [
  "sun",
  "moon",
  "clover",
  "bolt",
  "peaks",
  "dots",
  "arch",
  "wave",
  "spark",
  "leaf",
  "target",
  "plus",
] as const;

export const AVATAR_COLORS = [
  "sage",
  "pine",
  "clay",
  "coral",
  "honey",
  "blush",
  "plum",
  "lilac",
  "sky",
  "slate",
  "mist",
  "moss",
] as const;

export type AvatarGlyph = (typeof AVATAR_GLYPHS)[number];
export type AvatarColor = (typeof AVATAR_COLORS)[number];

export type Avatar = { glyph: AvatarGlyph; color: AvatarColor };

/** GET /profile, and what PATCH /profile answers. */
export type ProfileResponse = { avatar: Avatar };

/** PATCH /profile. */
export type UpdateProfileBody = { avatar: Avatar };

/**
 * The picture someone has until they pick one: the same for the same id
 * every time, and spread across the lists so two people rarely share it.
 */
export function defaultAvatar(userId: string): Avatar {
  // FNV-1a: small, and enough to scatter ids that differ by a character.
  let hash = 0x811c9dc5;
  for (let index = 0; index < userId.length; index++) {
    hash ^= userId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return {
    glyph: AVATAR_GLYPHS[hash % AVATAR_GLYPHS.length]!,
    color:
      AVATAR_COLORS[
        Math.floor(hash / AVATAR_GLYPHS.length) % AVATAR_COLORS.length
      ]!,
  };
}
