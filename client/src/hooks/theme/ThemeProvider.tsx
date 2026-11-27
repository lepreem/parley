import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ThemeContext } from "./context";
import {
  DEFAULT_MODE,
  DEFAULT_THEME,
  isMode,
  isThemeId,
  MODE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  type Mode,
  type ResolvedMode,
  type ThemeId,
} from "./themes";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows can refuse; the pick still holds until the tab closes.
  }
}

function systemMode(): ResolvedMode {
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/** Follows the system's light or dark setting as it changes. */
function useSystemMode(): ResolvedMode {
  const [mode, setMode] = useState(systemMode);
  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const onChange = () => setMode(query.matches ? "dark" : "light");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return mode;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeId>(() => {
    const stored = read(THEME_STORAGE_KEY);
    return isThemeId(stored) ? stored : DEFAULT_THEME;
  });
  const [mode, setMode] = useState<Mode>(() => {
    const stored = read(MODE_STORAGE_KEY);
    return isMode(stored) ? stored : DEFAULT_MODE;
  });
  const system = useSystemMode();
  const resolvedMode = mode === "system" ? system : mode;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.classList.toggle("dark", resolvedMode === "dark");
  }, [theme, resolvedMode]);

  useEffect(() => write(THEME_STORAGE_KEY, theme), [theme]);
  useEffect(() => write(MODE_STORAGE_KEY, mode), [mode]);

  const value = useMemo(
    () => ({ theme, setTheme, mode, setMode, resolvedMode }),
    [theme, mode, resolvedMode],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}
