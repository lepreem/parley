import type { Avatar as AvatarIds } from "@parley/contract/avatars";
import { COLOR_ART, GLYPH_ART } from "./avatarArt";

/**
 * A person's picture: their glyph on their colour's disc. Decorative: whatever
 * holds it says whose it is.
 */
export function Avatar({
  avatar,
  className = "h-8 w-8",
}: {
  avatar: AvatarIds;
  className?: string;
}) {
  const { disc, ink } = COLOR_ART[avatar.color];
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="12" fill={disc} />
      {/* The glyph's own 24-unit grid, shrunk into the middle of the disc. */}
      <g
        transform="translate(4.56 4.56) scale(0.62)"
        fill={ink}
        style={{ color: ink }}
      >
        {GLYPH_ART[avatar.glyph]}
      </g>
    </svg>
  );
}
