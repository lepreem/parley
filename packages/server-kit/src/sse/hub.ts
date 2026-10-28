import type { Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import type { ServerEvents } from "@parley/contract";

/**
 * How often an open stream gets a comment line, so a proxy doesn't take a
 * quiet stream for a dead one and close it.
 */
export const HEARTBEAT_MS = 20_000;

/**
 * The GET /events streams browsers hold open, grouped by whose they are: a
 * user id on the cloud, everyone at once on the local server. An event goes
 * to every stream in its group, typed by the contract's ServerEvents.
 *
 * Only this process's streams: a server running as several instances needs
 * each instance to hear every event, which this doesn't do.
 */
export function createEventHub<Group extends string>() {
  const groups = new Map<Group, Set<SSEStreamingApi>>();

  function join(group: Group, stream: SSEStreamingApi) {
    let members = groups.get(group);
    if (!members) groups.set(group, (members = new Set()));
    members.add(stream);
  }

  function leave(group: Group, stream: SSEStreamingApi) {
    const members = groups.get(group);
    members?.delete(stream);
    if (members?.size === 0) groups.delete(group);
  }

  return {
    /**
     * Answers GET /events for `group`: holds the stream open, with a
     * heartbeat, until the client goes or the hub closes.
     */
    stream(c: Context, group: Group) {
      return streamSSE(c, async (stream) => {
        join(group, stream);
        try {
          // Also flushes the headers, so the client knows it's connected.
          while (!stream.aborted && !stream.closed) {
            await stream.write(": heartbeat\n\n");
            await stream.sleep(HEARTBEAT_MS);
          }
        } finally {
          leave(group, stream);
        }
      });
    },

    /** Pushes an event to every open stream in `group`. */
    send<E extends keyof ServerEvents>(
      group: Group,
      event: E,
      payload: ServerEvents[E],
    ) {
      for (const stream of groups.get(group) ?? []) {
        // A stream that went away mid-write is dropped when its loop ends.
        stream
          .writeSSE({ event, data: JSON.stringify(payload) })
          .catch(() => undefined);
      }
    },

    /** Ends every open stream, so the server can close: for shutdown. */
    async close() {
      const streams = [...groups.values()].flatMap((members) => [...members]);
      groups.clear();
      await Promise.all(streams.map((stream) => stream.close()));
    },
  };
}
