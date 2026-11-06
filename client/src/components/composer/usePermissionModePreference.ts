import { useCallback, useState } from "react";
import type { PermissionMode } from "../../api/toolApprovals";

const STORAGE_KEY = "parley-permission-mode";

/** Storage can throw when it's blocked; the choice then lasts as long as the page. */
function readStored(): PermissionMode | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "acceptEdits" || stored === "bypassPermissions"
      ? stored
      : null;
  } catch {
    return null;
  }
}

/**
 * How freely Claude Code on this computer may act, beyond the person's own
 * settings. Null, the start, leaves it to those settings.
 */
export function usePermissionModePreference() {
  const [mode, setMode] = useState(readStored);

  const set = useCallback((next: PermissionMode | null) => {
    setMode(next);
    try {
      if (next) window.localStorage.setItem(STORAGE_KEY, next);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to do: it still holds for this page.
    }
  }, []);

  return [mode, set] as const;
}
