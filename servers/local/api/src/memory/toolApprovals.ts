import { randomUUID } from "node:crypto";
import type { ToolApproval, ToolApprovalChoice } from "@parley/contract";
import type {
  PermissionAnswer,
  PermissionRequest,
} from "../../../core/ai/ai_chat_client";
import { EVERYONE, eventHub } from "../sse/hub";

const DECLINED =
  "The person declined this. Don't try it another way unless they ask.";
const RUN_ENDED = "The reply this was for has ended.";

/** A reply's run, and whether the person has said to allow it everything. */
type Run = { conversationId: string; allowAll: boolean };

type Waiting = ToolApproval & {
  run: Run;
  request: PermissionRequest;
  settle: (answer: PermissionAnswer) => void;
};

/**
 * The tool calls replies are waiting on the person for, from whichever program
 * runs the chat; each one's adapter has already put its request in the card's
 * terms. Nothing times out: a prompt waits for an answer for as long as its
 * reply runs, as in a terminal. An approval's id is random, so only a page
 * that was told about it can answer it.
 */
function createToolApprovals() {
  const waiting = new Map<string, Waiting>();
  /**
   * What each conversation was allowed for as long as it lasts: a terminal
   * session's "don't ask again", which is the whole conversation there. Each
   * message here is a run of its own, so it's handed to the conversation's
   * later runs, for the adapter that made it to read.
   */
  const carriedByConversation = new Map<string, unknown[]>();

  const pending = (conversationId: string): ToolApproval[] =>
    [...waiting.values()]
      .filter((entry) => entry.run.conversationId === conversationId)
      .map(({ id, program, toolName, detail, always }) => ({
        id,
        program,
        toolName,
        detail,
        always,
      }));

  const announce = (conversationId: string) =>
    eventHub.send(EVERYONE, "toolApprovalsChanged", {
      conversationId,
      approvals: pending(conversationId),
    });

  /** Takes it off the list and answers the program. */
  function finish(entry: Waiting, answer: PermissionAnswer) {
    if (!waiting.delete(entry.id)) return;
    entry.settle(answer);
    announce(entry.run.conversationId);
  }

  return {
    /** Starts a reply's prompts. `close` refuses any it left unanswered. */
    open(conversationId: string) {
      const run: Run = { conversationId, allowAll: false };

      return {
        /** Asks the person about a tool call, resolving with what they said. */
        ask(
          request: PermissionRequest,
          signal: AbortSignal,
        ): Promise<PermissionAnswer> {
          if (run.allowAll) return Promise.resolve({ decision: "allow" });
          if (signal.aborted) {
            return Promise.resolve({ decision: "deny", message: RUN_ENDED });
          }

          return new Promise((settle) => {
            const entry: Waiting = {
              id: randomUUID(),
              program: request.program,
              toolName: request.toolName,
              detail: request.detail,
              always: request.always,
              run,
              request,
              settle,
            };
            waiting.set(entry.id, entry);
            // The program stopped waiting, as when the reply was stopped.
            signal.addEventListener(
              "abort",
              () => finish(entry, { decision: "deny", message: RUN_ENDED }),
              { once: true },
            );
            announce(conversationId);
          });
        },

        close() {
          for (const entry of waiting.values()) {
            if (entry.run === run) {
              finish(entry, { decision: "deny", message: RUN_ENDED });
            }
          }
        },
      };
    },

    pending,

    /** What earlier runs in the conversation were told not to ask about again. */
    carried: (conversationId: string): readonly unknown[] =>
      carriedByConversation.get(conversationId) ?? [],

    /** The person's answer. False when it's no longer waiting. */
    answer(conversationId: string, id: string, choice: ToolApprovalChoice) {
      const entry = waiting.get(id);
      if (entry?.run.conversationId !== conversationId) return false;

      if (choice === "deny") {
        finish(entry, { decision: "deny", message: DECLINED });
      } else if (choice === "always") {
        carriedByConversation.set(conversationId, [
          ...(carriedByConversation.get(conversationId) ?? []),
          ...entry.request.carry,
        ]);
        finish(entry, { decision: "always" });
      } else {
        finish(entry, { decision: "allow" });
      }
      // A program won't switch a run it started asking into its own
      // allow-everything mode, so the rest of this one is allowed here, and
      // the person's next message starts in that mode.
      if (choice === "allowAll") {
        entry.run.allowAll = true;
        for (const other of waiting.values()) {
          if (other.run === entry.run) finish(other, { decision: "allow" });
        }
      }
      return true;
    },
  };
}

export const toolApprovals = createToolApprovals();
