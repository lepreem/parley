import type { ReactNode } from "react";
import type { AvatarColor, AvatarGlyph } from "@parley/contract/avatars";

/**
 * What each id in @parley/contract/avatars looks like. Glyphs sit on a 24-unit
 * grid and draw in currentColor: filled shapes, or round-capped strokes where
 * a line reads better than a shape.
 */
const line = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export const GLYPH_ART: Record<AvatarGlyph, ReactNode> = {
  sun: (
    <>
      <circle cx="12" cy="12" r="4.6" />
      <path
        {...line}
        strokeWidth={2.4}
        d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.55 1.55M17.15 17.15l1.55 1.55M5.3 18.7l1.55-1.55M17.15 6.85l1.55-1.55"
      />
    </>
  ),
  moon: <path d="M20.5 14.2A8.6 8.6 0 1 1 9.8 3.5a6.8 6.8 0 0 0 10.7 10.7Z" />,
  clover: (
    <>
      <circle cx="12" cy="7" r="4.4" />
      <circle cx="12" cy="17" r="4.4" />
      <circle cx="7" cy="12" r="4.4" />
      <circle cx="17" cy="12" r="4.4" />
    </>
  ),
  bolt: (
    <path
      {...line}
      fill="currentColor"
      strokeWidth={1.4}
      d="M13.6 2.5 5.2 13.4h6.1l-1.1 8.1 8.6-11.1h-6.2l1-7.9Z"
    />
  ),
  peaks: (
    <path
      {...line}
      fill="currentColor"
      strokeWidth={1.4}
      d="M2.5 19.5 9 7.5l4.1 7.4 2.6-4.4 5.8 9Z"
    />
  ),
  dots: (
    <>
      {[5.5, 12, 18.5].flatMap((y) =>
        [5.5, 12, 18.5].map((x) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="2.3" />
        )),
      )}
    </>
  ),
  arch: (
    <path
      {...line}
      strokeWidth={3}
      strokeLinecap="butt"
      d="M3.5 19a8.5 8.5 0 0 1 17 0M9 19a3 3 0 0 1 6 0"
    />
  ),
  wave: (
    <path
      {...line}
      d="M3 7c2.25-2.4 4.5 2.4 6.75 0S14.25 4.6 16.5 7 19.5 7 21 6M3 12.5c2.25-2.4 4.5 2.4 6.75 0s4.5-2.4 6.75 0 3 1 4.5-.5M3 18c2.25-2.4 4.5 2.4 6.75 0s4.5-2.4 6.75 0 3 1 4.5-.5"
    />
  ),
  spark: (
    <path d="M12 2c.75 5.4 4.6 9.25 10 10-5.4.75-9.25 4.6-10 10-.75-5.4-4.6-9.25-10-10 5.4-.75 9.25-4.6 10-10Z" />
  ),
  leaf: (
    <path
      {...line}
      fill="currentColor"
      strokeWidth={1.4}
      d="M4.5 19.5C4.5 10 10 4.5 20 4c-.5 10-6 15.5-15.5 15.5Z"
    />
  ),
  target: (
    <>
      <circle {...line} cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.4" />
    </>
  ),
  plus: (
    <>
      <rect x="9.25" y="3" width="5.5" height="18" rx="2.2" />
      <rect x="3" y="9.25" width="18" height="5.5" rx="2.2" />
    </>
  ),
};

/**
 * Each colour's disc, and the ink its glyph draws in: dark on the pale ones,
 * cream on the deep ones. Fixed in both themes, so a picture looks the same
 * wherever it shows up.
 */
export const COLOR_ART: Record<AvatarColor, { disc: string; ink: string }> = {
  sage: { disc: "#a9c4b5", ink: "#16191c" },
  pine: { disc: "#4f8a7b", ink: "#faf7f0" },
  clay: { disc: "#cc7752", ink: "#faf7f0" },
  coral: { disc: "#d8645e", ink: "#faf7f0" },
  honey: { disc: "#e6b566", ink: "#16191c" },
  blush: { disc: "#e8c6ce", ink: "#16191c" },
  plum: { disc: "#9f5880", ink: "#faf7f0" },
  lilac: { disc: "#8780c6", ink: "#faf7f0" },
  sky: { disc: "#6c98cf", ink: "#faf7f0" },
  slate: { disc: "#56667a", ink: "#faf7f0" },
  mist: { disc: "#c9d4e0", ink: "#16191c" },
  moss: { disc: "#86854c", ink: "#faf7f0" },
};

/** How the picker names each one to a screen reader. */
export const GLYPH_LABELS: Record<AvatarGlyph, string> = {
  sun: "Sun",
  moon: "Moon",
  clover: "Clover",
  bolt: "Bolt",
  peaks: "Peaks",
  dots: "Dots",
  arch: "Arch",
  wave: "Waves",
  spark: "Spark",
  leaf: "Leaf",
  target: "Target",
  plus: "Plus",
};

export const COLOR_LABELS: Record<AvatarColor, string> = {
  sage: "Sage",
  pine: "Pine",
  clay: "Clay",
  coral: "Coral",
  honey: "Honey",
  blush: "Blush",
  plum: "Plum",
  lilac: "Lilac",
  sky: "Sky",
  slate: "Slate",
  mist: "Mist",
  moss: "Moss",
};
