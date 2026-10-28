import type { Server } from "../../api/server";
import { ServerContext } from "../../hooks/server/context";
import { EventsProvider } from "../../sse/EventsProvider";
import { AppShell } from "./AppShell";

/**
 * One server's part of the app: the cloud's or this computer's. Everything
 * inside asks that server, over its own event stream, and keeps its own drafts, so
 * the two sections never share a conversation or a source.
 */
export function Section({ server }: { server: Server }) {
  return (
    <ServerContext.Provider value={server}>
      <EventsProvider key={server.id}>
        <AppShell />
      </EventsProvider>
    </ServerContext.Provider>
  );
}
