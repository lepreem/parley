import { createContext } from "react";
import type { Mode, ResolvedMode, ThemeId } from "./themes";

export type ThemeContextValue = {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
  mode: Mode;
  setMode: (mode: Mode) => void;
  /** What the page shows now: `mode`, with "system" settled. */
  resolvedMode: ResolvedMode;
};

export const ThemeContext = createContext<ThemeContextValue | null>(null);
