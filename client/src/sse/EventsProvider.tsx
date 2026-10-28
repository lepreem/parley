import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ServerEvents } from "@parley/contract";
import { readServerSentEvents } from "./reader";
import { apiFetch } from "../api/http";
import { useServer } from "../hooks/server/useServer";
import { useServerReady } from "../hooks/server/useServerReady";
import { EventsContext, type EventListener } from "./context";

/** How long to wait before opening the stream again, by failed attempt. */
const RETRY_MS = [1_000, 2_000, 5_000, 15_000];

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Holds the current server's GET /events stream open for as long as the
 * section is mounted, and opens it again whenever it ends. It goes through
 * apiFetch, so on the cloud an expired session is refreshed before the next
 * attempt, as any request's is.
 */
export function EventsProvider({ children }: { children: ReactNode }) {
  const server = useServer();
  const ready = useServerReady();
  const [connected, setConnected] = useState(false);
  const listeners = useRef(
    new Map<keyof ServerEvents, Set<EventListener<keyof ServerEvents>>>(),
  );

  useEffect(() => {
    if (!ready) return;
    const abort = new AbortController();

    void (async () => {
      for (let attempt = 0; !abort.signal.aborted;) {
        try {
          const response = await apiFetch(server, "/events", {
            signal: abort.signal,
            headers: { Accept: "text/event-stream" },
          });
          if (!response.body) throw new Error("The event stream was empty");
          setConnected(true);
          attempt = 0;
          await readServerSentEvents(response.body, ({ event, data }) => {
            const payload = JSON.parse(data) as never;
            listeners.current
              .get(event as keyof ServerEvents)
              ?.forEach((listener) => listener(payload));
          });
        } catch {
          // Couldn't open, or the stream broke: either way, open it again.
        }
        setConnected(false);
        if (abort.signal.aborted) return;
        await wait(
          RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)],
          abort.signal,
        );
      }
    })();

    return () => abort.abort();
  }, [server, ready]);

  const subscribe = useCallback(
    <E extends keyof ServerEvents>(event: E, listener: EventListener<E>) => {
      const forEvent = listeners.current.get(event) ?? new Set();
      listeners.current.set(event, forEvent);
      const stored = listener as EventListener<keyof ServerEvents>;
      forEvent.add(stored);
      return () => {
        forEvent.delete(stored);
      };
    },
    [],
  );

  const value = useMemo(
    () => ({ connected, subscribe }),
    [connected, subscribe],
  );
  return (
    <EventsContext.Provider value={value}>{children}</EventsContext.Provider>
  );
}
