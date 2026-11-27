/**
 * The palettes a person can pick. Each is an accent colour only: backgrounds,
 * borders and text are the same greys in all of them. The colours live in
 * themes.css, once for light and once for dark; themes.test.ts fails if a
 * palette here is missing there, or sets more than the accent.
 */
// The ids are what's saved on each device, so they keep their old names.
export const THEMES = [
  { id: "studio", label: "Teal", blurb: "The default" },
  { id: "paper", label: "Amber", blurb: "Warm orange" },
  { id: "graphite", label: "Graphite", blurb: "No colour" },
  { id: "forest", label: "Moss", blurb: "Soft green" },
  { id: "plum", label: "Plum", blurb: "Violet" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export const DEFAULT_THEME: ThemeId = "studio";

/** Light or dark, or whichever the system is set to right now. */
export const MODES = ["light", "dark", "system"] as const;

export type Mode = (typeof MODES)[number];

export type ResolvedMode = Exclude<Mode, "system">;

export const DEFAULT_MODE: Mode = "system";

/** Kept per device. index.html reads the same keys before the first paint. */
export const THEME_STORAGE_KEY = "parley-palette";
export const MODE_STORAGE_KEY = "parley-mode";

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

export function isMode(value: unknown): value is Mode {
  return MODES.some((mode) => mode === value);
}
