import { randomUUID } from "node:crypto";
import type { ToolApproval } from "@parley/contract";
import { EVERYONE, eventHub } from "../sse/hub";

/** Where a run reaches this server to ask about a tool call. */
export const TOOL_APPROVAL_SERVER_PATH = "/tool-approvals/mcp";

/**
 * How long a prompt waits for the person. It stays well under the reply's own
 * time limits, so a turn nobody's watching ends with a refusal the model can
 * explain rather than a run that's cut off.
 */
const ANSWER_WAIT_MS = 4 * 60 * 1000; // 4 minutes
/** What Claude Code allows the server to take, past which it gives up. */
const SERVER_TIMEOUT_MS = ANSWER_WAIT_MS + 30 * 1000;

const DECLINED =
  "The person declined this. Don't try it another way unless they ask.";
const NO_ANSWER = "The person didn't answer in time, so this wasn't done.";
const RUN_ENDED = "The reply this was for has ended.";
/** Claude Code's own question tool needs an answer the app has no screen for. */
const ASK_IN_REPLY =
  "This app can't show that tool. Ask in your reply instead, and the person will answer in their next message.";

/** The answer Claude Code expects from a permission prompt tool. */
type ToolApprovalAnswer =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

type Waiting = ToolApproval & {
  conversationId: string;
  token: string;
  input: Record<string, unknown>;
  timer: NodeJS.Timeout;
  settle: (answer: ToolApprovalAnswer) => void;
};

type Run = { conversationId: string; markProgress: () => void };

/** What the person sees: the command itself, or the tool's input in full. */
function detailOf(toolName: string, input: Record<string, unknown>) {
  if (toolName === "Bash" && typeof input.command === "string") {
    return input.command;
  }
  return JSON.stringify(input, null, 2);
}

/**
 * The tool calls replies are waiting on the person for. Each chat run gets a
 * token, which is how the prompts it sends here are told from anyone else's, and
 * an approval's id is random: only a page that was told about it can answer it.
 */
function createToolApprovals() {
  const runs = new Map<string, Run>();
  const waiting = new Map<string, Waiting>();

  const pending = (conversationId: string): ToolApproval[] =>
    [...waiting.values()]
      .filter((entry) => entry.conversationId === conversationId)
      .map(({ id, toolName, detail }) => ({ id, toolName, detail }));

  const announce = (conversationId: string) =>
    eventHub.send(EVERYONE, "toolApprovalsChanged", {
      conversationId,
      approvals: pending(conversationId),
    });

  /** Takes it off the list and answers Claude Code. */
  function finish(entry: Waiting, answer: ToolApprovalAnswer) {
    clearTimeout(entry.timer);
    waiting.delete(entry.id);
    entry.settle(answer);
    runs.get(entry.token)?.markProgress();
    announce(entry.conversationId);
  }

  return {
    /** Starts a chat run's prompts. `close` refuses any it left unanswered. */
    open(conversationId: string) {
      const token = randomUUID();
      const run: Run = { conversationId, markProgress: () => {} };
      runs.set(token, run);
      return {
        token,
        timeoutMs: SERVER_TIMEOUT_MS,
        onActivity: (markProgress: () => void) => {
          run.markProgress = markProgress;
        },
        close() {
          for (const entry of waiting.values()) {
            if (entry.token === token) {
              finish(entry, { behavior: "deny", message: RUN_ENDED });
            }
          }
          runs.delete(token);
        },
      };
    },

    isOpen: (token: string) => runs.has(token),

    /** Asks the person about a tool call, resolving with what they said. */
    ask(
      token: string,
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<ToolApprovalAnswer> {
      const run = runs.get(token);
      if (!run) {
        return Promise.resolve({ behavior: "deny", message: RUN_ENDED });
      }
      if (toolName === "AskUserQuestion") {
        return Promise.resolve({ behavior: "deny", message: ASK_IN_REPLY });
      }

      return new Promise((settle) => {
        const entry: Waiting = {
          id: randomUUID(),
          toolName,
          detail: detailOf(toolName, input),
          conversationId: run.conversationId,
          token,
          input,
          settle,
          timer: setTimeout(
            () => finish(entry, { behavior: "deny", message: NO_ANSWER }),
            ANSWER_WAIT_MS,
          ),
        };
        waiting.set(entry.id, entry);
        run.markProgress();
        announce(run.conversationId);
      });
    },

    pending,

    /** The person's answer. False when it's no longer waiting. */
    answer(conversationId: string, id: string, allow: boolean) {
      const entry = waiting.get(id);
      if (entry?.conversationId !== conversationId) return false;
      finish(
        entry,
        allow
          ? { behavior: "allow", updatedInput: entry.input }
          : { behavior: "deny", message: DECLINED },
      );
      return true;
    },
  };
}

export const toolApprovals = createToolApprovals();
