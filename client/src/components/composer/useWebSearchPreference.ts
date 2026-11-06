import { useCallback, useState } from "react";

const STORAGE_KEY = "parley-web-search";

/** Storage can throw when it's blocked; the choice then lasts as long as the page. */
function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Whether the person wants the model on the web, on until they turn it off. */
export function useWebSearchPreference() {
  const [on, setOn] = useState(() => readStored() !== "off");

  const set = useCallback((next: boolean) => {
    setOn(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
    } catch {
      // Nothing to do: it still holds for this page.
    }
  }, []);

  return [on, set] as const;
}
