import { createContext } from "react";
import type { ServerEvents } from "@parley/contract";

export type EventListener<E extends keyof ServerEvents> = (
  payload: ServerEvents[E],
) => void;

export type Events = {
  /** Whether the stream is open, so pushes are arriving right now. */
  connected: boolean;
  /** Listens for an event on the stream; returns the unsubscribe. */
  subscribe<E extends keyof ServerEvents>(
    event: E,
    listener: EventListener<E>,
  ): () => void;
};

export const EventsContext = createContext<Events | null>(null);
