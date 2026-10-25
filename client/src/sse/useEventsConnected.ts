import { useContext } from "react";
import { EventsContext } from "./context";

/**
 * Whether job updates are arriving by push right now. Callers use it to decide
 * whether they need to poll at all — see useTranscriptWatcher.
 */
export function useEventsConnected(): boolean {
  return useContext(EventsContext)?.connected ?? false;
}
