/**
 * The palettes a person can pick. Each one's colours live in themes.css, once
 * for light and once for dark; themes.test.ts fails if a palette here is
 * missing there, or misses a token in either mode.
 */
export const THEMES = [
  { id: "studio", label: "Studio", blurb: "Teal on cool grey" },
  { id: "paper", label: "Paper", blurb: "Warm cream, amber accent" },
  { id: "graphite", label: "Graphite", blurb: "Plain greys, no colour" },
  { id: "forest", label: "Forest", blurb: "Green-grey, moss accent" },
  { id: "plum", label: "Plum", blurb: "Cool violet" },
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
