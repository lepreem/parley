import { randomUUID } from "node:crypto";
import type {
  PermissionMode,
  ToolApproval,
  ToolApprovalChoice,
} from "@parley/contract";
import type {
  PermissionAnswer,
  PermissionRequest,
} from "../../../core/ai/ai_chat_client";
import { EVERYONE, eventHub } from "../sse/hub";

const DECLINED =
  "The person declined this. Don't try it another way unless they ask.";
const RUN_ENDED = "The reply this was for has ended.";
/** Claude Code's own question tool needs an answer the app has no screen for. */
const ASK_IN_REPLY =
  "This app can't show that tool. Ask in your reply instead, and the person will answer in their next message.";

/** One of Claude Code's "don't ask again" suggestions, as far as it's read here. */
type Suggestion = {
  type?: string;
  behavior?: string;
  rules?: { toolName?: string; ruleContent?: string }[];
  mode?: string;
  directories?: string[];
  /** "session" is for this run; the others are settings files Claude Code writes. */
  destination?: string;
};

const ruleText = (rule: { toolName?: string; ruleContent?: string }) =>
  rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;

/**
 * What a conversation has been allowed for as long as it lasts: Claude Code's
 * "don't ask again" for its session, which in the terminal is the whole
 * conversation. Each message here is a run of its own, so they're handed to
 * each later run in the conversation, as settings.
 */
type SessionGrants = {
  allow: string[];
  directories: string[];
  mode: PermissionMode | null;
};

const isPermissionMode = (mode: unknown): mode is PermissionMode =>
  mode === "acceptEdits" || mode === "bypassPermissions";

/**
 * Claude Code's suggestions, as the person is offered them: one button, as its
 * terminal has one "don't ask again". Taking it passes them all back as they
 * came. `rules` lists what's saved to their settings; what lasts only for the
 * reply, like access to a folder, isn't listed. `mode` is set only when
 * switching mode is the whole suggestion, as for a file edit, since that's
 * when later messages should carry on in it.
 */
function alwaysOf(suggestions: unknown[]): ToolApproval["always"] {
  if (suggestions.length === 0) return null;
  const rules: string[] = [];
  const modes: PermissionMode[] = [];
  for (const suggestion of suggestions as Suggestion[]) {
    if (
      suggestion.type === "addRules" &&
      suggestion.behavior === "allow" &&
      suggestion.destination !== "session"
    ) {
      for (const rule of suggestion.rules ?? []) {
        if (rule.toolName) rules.push(ruleText(rule) as string);
      }
    } else if (
      suggestion.type === "setMode" &&
      isPermissionMode(suggestion.mode)
    ) {
      modes.push(suggestion.mode);
    }
  }
  const mode = suggestions.length === 1 ? (modes[0] ?? null) : null;
  return {
    label: mode === "acceptEdits" ? "Allow all edits" : "Always allow",
    rules,
    mode,
  };
}

/** What the person sees: the command itself, or the tool's input in full. */
function detailOf(toolName: string, input: Record<string, unknown>) {
  if (toolName === "Bash" && typeof input.command === "string") {
    return input.command;
  }
  return JSON.stringify(input, null, 2);
}

/** A reply's run, and whether the person has said to allow it everything. */
type Run = { conversationId: string; allowAll: boolean };

type Waiting = ToolApproval & {
  run: Run;
  request: PermissionRequest;
  settle: (answer: PermissionAnswer) => void;
};

const allow = (
  request: PermissionRequest,
  updatedPermissions?: unknown[],
): PermissionAnswer => ({
  behavior: "allow",
  updatedInput: request.input,
  ...(updatedPermissions ? { updatedPermissions } : {}),
});

/**
 * The tool calls replies are waiting on the person for. Nothing times out: a
 * prompt waits for an answer for as long as its reply runs, as Claude Code in
 * a terminal does. An approval's id is random, so only a page that was told
 * about it can answer it.
 */
function createToolApprovals() {
  const waiting = new Map<string, Waiting>();
  const grants = new Map<string, SessionGrants>();

  /** Keeps a conversation's session-long suggestions for its later runs. */
  function grant(conversationId: string, suggestions: unknown[]) {
    const held = grants.get(conversationId) ?? {
      allow: [],
      directories: [],
      mode: null,
    };
    for (const suggestion of suggestions as Suggestion[]) {
      if (suggestion.destination !== "session") continue;
      if (suggestion.type === "addRules" && suggestion.behavior === "allow") {
        for (const rule of suggestion.rules ?? []) {
          if (rule.toolName) held.allow.push(ruleText(rule) as string);
        }
      } else if (suggestion.type === "addDirectories") {
        held.directories.push(...(suggestion.directories ?? []));
      } else if (
        suggestion.type === "setMode" &&
        isPermissionMode(suggestion.mode)
      ) {
        held.mode = suggestion.mode;
      }
    }
    grants.set(conversationId, held);
  }

  const pending = (conversationId: string): ToolApproval[] =>
    [...waiting.values()]
      .filter((entry) => entry.run.conversationId === conversationId)
      .map(({ id, toolName, detail, always }) => ({
        id,
        toolName,
        detail,
        always,
      }));

  const announce = (conversationId: string) =>
    eventHub.send(EVERYONE, "toolApprovalsChanged", {
      conversationId,
      approvals: pending(conversationId),
    });

  /** Takes it off the list and answers Claude Code. */
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
          if (request.toolName === "AskUserQuestion") {
            return Promise.resolve({ behavior: "deny", message: ASK_IN_REPLY });
          }
          if (run.allowAll) return Promise.resolve(allow(request));
          if (signal.aborted) {
            return Promise.resolve({ behavior: "deny", message: RUN_ENDED });
          }

          return new Promise((settle) => {
            const entry: Waiting = {
              id: randomUUID(),
              toolName: request.toolName,
              detail: detailOf(request.toolName, request.input),
              always: alwaysOf(request.suggestions),
              run,
              request,
              settle,
            };
            waiting.set(entry.id, entry);
            // Claude Code stopped waiting, as when the reply was stopped.
            signal.addEventListener(
              "abort",
              () => finish(entry, { behavior: "deny", message: RUN_ENDED }),
              { once: true },
            );
            announce(conversationId);
          });
        },

        close() {
          for (const entry of waiting.values()) {
            if (entry.run === run) {
              finish(entry, { behavior: "deny", message: RUN_ENDED });
            }
          }
        },
      };
    },

    pending,

    /** What earlier runs in the conversation were told not to ask about again. */
    sessionGrants: (conversationId: string): SessionGrants | undefined =>
      grants.get(conversationId),

    /** The person's answer. False when it's no longer waiting. */
    answer(conversationId: string, id: string, choice: ToolApprovalChoice) {
      const entry = waiting.get(id);
      if (entry?.run.conversationId !== conversationId) return false;

      if (choice === "deny") {
        finish(entry, { behavior: "deny", message: DECLINED });
      } else if (choice === "always") {
        grant(conversationId, entry.request.suggestions);
        finish(entry, allow(entry.request, entry.request.suggestions));
      } else {
        finish(entry, allow(entry.request));
      }
      // Claude Code won't switch a run it started asking into its own
      // allow-everything mode, so the rest of this one is allowed here, and
      // the person's next message starts in that mode.
      if (choice === "allowAll") {
        entry.run.allowAll = true;
        for (const other of waiting.values()) {
          if (other.run === entry.run) finish(other, allow(other.request));
        }
      }
      return true;
    },
  };
}

export const toolApprovals = createToolApprovals();
