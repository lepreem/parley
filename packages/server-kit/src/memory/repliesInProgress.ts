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
export function createRepliesInProgress() {
  const entries = new Map<
    string,
    { reply: ReplyInProgress; controller: AbortController }
  >();

  return {
    /**
     * Adds an entry for the reply to `content`. Call `remove` on it once the
     * reply is saved or failed; a later entry under the same key replaces this one.
     */
    add(key: string, content: string) {
      const entry = {
        reply: { content, assistantContent: "" },
        controller: new AbortController(),
      };
      entries.set(key, entry);

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
        remove() {
          if (entries.get(key) === entry) entries.delete(key);
        },
      };
    },

    /** The reply being written under `key`, as it stands. */
    find(key: string): ReplyInProgress | null {
      const entry = entries.get(key);
      return entry ? { ...entry.reply } : null;
    },

    /** Stops the reply under `key`. False when there's none to stop. */
    stop(key: string) {
      const entry = entries.get(key);
      if (!entry) return false;
      entry.controller.abort(new ReplyStopped());
      return true;
    },
  };
}

type RepliesInProgress = ReturnType<typeof createRepliesInProgress>;
export type ReplyInProgressEntry = ReturnType<RepliesInProgress["add"]>;
