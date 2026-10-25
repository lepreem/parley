import type { ReplyInProgress } from "@parley/contract";

/** Why a stopped reply's model call was aborted. */
export class ReplyStopped extends Error {
  constructor() {
    super("The reply was stopped");
    this.name = "ReplyStopped";
  }
}

/**
 * The replies this process is writing right now, keyed by conversation (with
 * its owner, on the cloud), so a reloaded page can see one is under way and
 * the stop button can reach it.
 *
 * Only this process's replies, like the event hub: a server running as several
 * instances would need the stop request to reach the one writing the reply.
 */
export function createReplyRegistry() {
  const replies = new Map<
    string,
    { reply: ReplyInProgress; controller: AbortController }
  >();

  return {
    /**
     * Starts tracking the reply to `content`. Call `end` once it's saved or
     * failed; a later reply under the same key replaces this one.
     */
    start(key: string, content: string) {
      const entry = {
        reply: { content, assistantContent: "" },
        controller: new AbortController(),
      };
      replies.set(key, entry);

      return {
        /** Aborts when someone stops the reply. */
        signal: entry.controller.signal,
        get stopped() {
          return entry.controller.signal.aborted;
        },
        /** The reply so far. */
        get text() {
          return entry.reply.assistantContent;
        },
        append(delta: string) {
          entry.reply.assistantContent += delta;
        },
        end() {
          if (replies.get(key) === entry) replies.delete(key);
        },
      };
    },

    /** The reply being written under `key`, as it stands. */
    find(key: string): ReplyInProgress | null {
      const entry = replies.get(key);
      return entry ? { ...entry.reply } : null;
    },

    /** Stops the reply under `key`. False when there's none to stop. */
    stop(key: string) {
      const entry = replies.get(key);
      if (!entry) return false;
      entry.controller.abort(new ReplyStopped());
      return true;
    },
  };
}

type ReplyRegistry = ReturnType<typeof createReplyRegistry>;
export type TrackedReply = ReturnType<ReplyRegistry["start"]>;
