import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import type {
  ChatModel,
  ModelReasoning,
  PermissionMode,
  ReasoningEffort,
  ToolApproval,
} from "@parley/contract";
import { getBaseEnv } from "../env";
import {
  CHAT_INSTRUCTIONS,
  conversationAsOneMessage,
  parseJsonLine,
  programEnv,
  type AskPermission,
  type ChatAdapter,
  type ChatRunOptions,
  type ChatTurn,
  type PermissionAnswer,
} from "./chatAdapter";

/**
 * Chat on the user's own Claude Code: each call is one `claude --print` run,
 * which answers on the user's plan rather than on an API key.
 */

/** Claude Code couldn't answer; the message is what it said went wrong. */
class ClaudeCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCodeError";
  }
}

/** Runs `claude` with `args`, resolving with what it printed. */
function runCommand(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(getBaseEnv().CLAUDE_PATH, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout);
      reject(
        new ClaudeCodeError(stderr.trim() || `claude exited with code ${code}`),
      );
    });
  });
}

type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

/** The conversation as the content of the one message Claude Code takes. */
function promptOf(turns: readonly ChatTurn[]): ContentBlock[] {
  return conversationAsOneMessage(turns).map((part) =>
    part.type === "text"
      ? part
      : {
          type: "image",
          source: {
            type: "base64",
            media_type: part.mimeType,
            data: part.data,
          },
        },
  );
}

/* ---------------------------------------------------- permission prompts */

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
function alwaysOf(suggestions: Suggestion[]): ToolApproval["always"] {
  if (suggestions.length === 0) return null;
  const rules: string[] = [];
  const modes: PermissionMode[] = [];
  for (const suggestion of suggestions) {
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

/**
 * What the conversation's earlier runs were allowed for their session: in the
 * terminal that's the whole conversation, but each message here is a run of
 * its own, so they're laid over the person's settings for this one, and a mode
 * one of them switched to carries on.
 */
function carriedGrants(carried: readonly unknown[]) {
  const allow: string[] = [];
  const directories: string[] = [];
  let mode: PermissionMode | undefined;
  for (const suggestion of carried as Suggestion[]) {
    if (suggestion.type === "addRules" && suggestion.behavior === "allow") {
      for (const rule of suggestion.rules ?? []) {
        if (rule.toolName) allow.push(ruleText(rule) as string);
      }
    } else if (suggestion.type === "addDirectories") {
      directories.push(...(suggestion.directories ?? []));
    } else if (
      suggestion.type === "setMode" &&
      isPermissionMode(suggestion.mode)
    ) {
      mode = suggestion.mode;
    }
  }
  const settings =
    allow.length > 0 || directories.length > 0
      ? { permissions: { allow, additionalDirectories: directories } }
      : undefined;
  return { settings, mode };
}

/** Claude Code's own question tool needs an answer the app has no screen for. */
const ASK_IN_REPLY =
  "This app can't show that tool. Ask in your reply instead, and the person will answer in their next message.";

/** What Claude Code takes as the answer to a permission prompt. */
type ClaudeAnswer =
  | {
      behavior: "allow";
      updatedInput: Record<string, unknown>;
      updatedPermissions?: unknown[];
    }
  | { behavior: "deny"; message: string };

/** Asks the person about one of Claude Code's prompts, in its own terms. */
async function askAbout(
  askPermission: AskPermission,
  toolName: string,
  input: Record<string, unknown>,
  suggestions: Suggestion[],
  signal: AbortSignal,
): Promise<ClaudeAnswer> {
  if (toolName === "AskUserQuestion") {
    return { behavior: "deny", message: ASK_IN_REPLY };
  }
  const answer: PermissionAnswer = await askPermission(
    {
      program: "Claude Code",
      toolName,
      detail: detailOf(toolName, input),
      always: alwaysOf(suggestions),
      carry: suggestions.filter(
        (suggestion) => suggestion.destination === "session",
      ),
    },
    signal,
  );
  if (answer.decision === "deny") {
    return { behavior: "deny", message: answer.message };
  }
  // Claude Code requires the input back, even unchanged.
  return {
    behavior: "allow",
    updatedInput: input,
    ...(answer.decision === "always"
      ? { updatedPermissions: suggestions }
      : {}),
  };
}

/* ------------------------------------------------------------------ runs */

/** How the app talks to a run; nothing here changes what Claude Code may do. */
const STREAM_ARGS = [
  "--print",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  // stream-json output requires it.
  "--verbose",
  "--include-partial-messages",
];

/**
 * A chat turn runs the user's Claude Code as they've set it up: their settings,
 * permissions, CLAUDE.md, MCP servers and hooks decide what it can do, as they
 * would in their terminal. The app adds only what it needs to carry the
 * conversation, and what the person picked in the app for this message.
 *
 * With --print nothing can answer a permission prompt, so a tool their settings
 * don't already allow is refused, unless the app takes the prompts over the
 * run's own input and output, as Anthropic's Agent SDK does. That changes who's
 * asked, not what gets asked about; `permissionMode` is the person's own pick.
 */
function chatArgs(
  model: string,
  effort: ReasoningEffort | undefined,
  webSearch: boolean,
  asksPermission: boolean,
  permissionMode: PermissionMode | undefined,
  settings: Record<string, unknown> | undefined,
) {
  return [
    ...STREAM_ARGS,
    "--model",
    model,
    "--append-system-prompt",
    CHAT_INSTRUCTIONS,
    webSearch ? "--allowedTools" : "--disallowedTools",
    "WebSearch",
    // It has no "none": turning thinking off is an environment variable.
    ...(effort && effort !== "none" ? ["--effort", effort] : []),
    // Laid over theirs, as a terminal session's "don't ask again" would be.
    ...(settings ? ["--settings", JSON.stringify(settings)] : []),
    ...(asksPermission ? ["--permission-prompt-tool", "stdio"] : []),
    ...(permissionMode ? ["--permission-mode", permissionMode] : []),
  ];
}

/**
 * A small job the app does for itself, like naming a conversation, rather than
 * a turn the person asked for: Claude Code as a plain model, which can't act on
 * the text it's given, and fires none of the person's hooks or saved sessions.
 */
function helperArgs(
  model: string,
  instructions: string,
  effort: ReasoningEffort | undefined,
) {
  return [
    ...STREAM_ARGS,
    "--model",
    model,
    "--system-prompt",
    instructions,
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    ...(effort && effort !== "none" ? ["--effort", effort] : []),
  ];
}

function claudeEnv(effort: ReasoningEffort | undefined): NodeJS.ProcessEnv {
  const env = programEnv();
  if (effort === "none") env.MAX_THINKING_TOKENS = "0";
  return env;
}

/** The lines of Claude Code's stream-json output that a run reads. */
type OutputLine =
  | {
      type: "stream_event";
      event: { type: string; delta?: { type: string; text?: string } };
    }
  | { type: "user"; tool_use_result?: { results?: unknown } }
  | { type: "result"; is_error: boolean; result?: string }
  | {
      type: "control_request";
      request_id: string;
      request: {
        subtype: string;
        tool_name?: string;
        input?: Record<string, unknown>;
        permission_suggestions?: Suggestion[];
      };
    }
  | { type: "control_cancel_request"; request_id: string }
  | { type: "other" };

/** Somewhere to write a run's control responses to, while it's listening. */
type ControlInput = { writableEnded: boolean; write: (line: string) => void };

/**
 * Answers a request Claude Code makes of the app mid-run. Only permission
 * prompts are answered; it's told the app has nothing else to offer.
 */
function answerControlRequest(
  input: ControlInput,
  { request_id, request }: Extract<OutputLine, { type: "control_request" }>,
  askPermission: AskPermission | undefined,
  waiting: Map<string, AbortController>,
) {
  const reply = (response: Record<string, unknown>) => {
    if (input.writableEnded) return;
    input.write(
      `${JSON.stringify({ type: "control_response", response: { request_id, ...response } })}\n`,
    );
  };
  if (request.subtype !== "can_use_tool" || !askPermission) {
    reply({ subtype: "error", error: `Not supported: ${request.subtype}` });
    return;
  }

  const controller = new AbortController();
  waiting.set(request_id, controller);
  void askAbout(
    askPermission,
    request.tool_name ?? "",
    request.input ?? {},
    request.permission_suggestions ?? [],
    controller.signal,
  )
    .catch((): ClaudeAnswer => ({
      behavior: "deny",
      message: "The app couldn't ask about this.",
    }))
    .then((answer) => {
      waiting.delete(request_id);
      if (!controller.signal.aborted) {
        reply({ subtype: "success", response: answer });
      }
    });
}

/** Hands over the pages one WebSearch result lists. */
function readSources(
  results: unknown,
  onSource: (url: unknown, title: unknown) => void,
) {
  if (!Array.isArray(results)) return;
  for (const result of results) {
    if (typeof result !== "object" || result === null) continue;
    const { content } = result as { content?: unknown };
    if (!Array.isArray(content)) continue;
    for (const page of content as { url?: unknown; title?: unknown }[]) {
      onSource(page.url, page.title);
    }
  }
}

type RunSettings = {
  args: string[];
  /** A helper needs no folder, and Claude Code would tell the model about one. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  abortSignal: AbortSignal;
  onText: (text: string) => void | Promise<void>;
  onSource: (url: unknown, title: unknown) => void;
  askPermission: AskPermission | undefined;
};

/**
 * Runs `claude` with the conversation as its one message, passing each piece
 * of the answer's text to `onText` as it arrives, and resolving with the whole
 * answer. Aborting `abortSignal` kills the run and rejects with its reason.
 */
async function run(
  turns: readonly ChatTurn[],
  { args, cwd, env, abortSignal, onText, onSource, askPermission }: RunSettings,
): Promise<string> {
  const child = spawn(getBaseEnv().CLAUDE_PATH, args, {
    windowsHide: true,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
    signal: abortSignal,
  });

  // A run that can't start, or is killed, reports why here; it still closes.
  let failure: unknown;
  child.on("error", (error) => (failure ??= error));
  const closed = new Promise<number | null>((resolve) =>
    child.on("close", resolve),
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  // A run that dies before reading its input says why when it closes.
  child.stdin.on("error", () => {});
  const prompt = `${JSON.stringify({
    type: "user",
    message: { role: "user", content: promptOf(turns) },
  })}\n`;
  // A run that may ask for permission reads its answers from the same input,
  // so it stays open until the run's result is in.
  if (askPermission) child.stdin.write(prompt);
  else child.stdin.end(prompt);
  /** The prompts Claude Code is waiting on, by request. */
  const waiting = new Map<string, AbortController>();

  let answer = "";
  let result: Extract<OutputLine, { type: "result" }> | undefined;
  /** A tool ran since the last text, so the next is a new paragraph. */
  let afterTool = false;

  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const output = parseJsonLine<OutputLine>(line);
      if (!output) continue;

      if (output.type === "result") {
        result = output;
        child.stdin.end();
      } else if (output.type === "control_request") {
        answerControlRequest(child.stdin, output, askPermission, waiting);
      } else if (output.type === "control_cancel_request") {
        waiting.get(output.request_id)?.abort();
      } else if (output.type === "user") {
        readSources(output.tool_use_result?.results, onSource);
      } else if (
        output.type === "stream_event" &&
        output.event.type === "message_start"
      ) {
        afterTool = answer !== "";
      } else if (
        output.type === "stream_event" &&
        output.event.type === "content_block_delta" &&
        output.event.delta?.type === "text_delta" &&
        output.event.delta.text
      ) {
        const text = `${afterTool ? "\n\n" : ""}${output.event.delta.text}`;
        afterTool = false;
        answer += text;
        await onText(text);
      }
    }
    const code = await closed;

    if (abortSignal.aborted) throw abortSignal.reason;
    if (failure) throw failure;
    if (!result) {
      throw new ClaudeCodeError(
        stderr.trim() || `claude exited with code ${code}`,
      );
    }
    if (result.is_error) {
      throw new ClaudeCodeError(result.result || "Claude Code failed");
    }
    return answer;
  } finally {
    // Whatever stopped reading the answer, the run doesn't outlive it, and
    // nobody is left being asked on its behalf.
    for (const controller of waiting.values()) controller.abort();
    if (child.exitCode === null) child.kill();
  }
}

function chat(
  model: string,
  turns: readonly ChatTurn[],
  options: ChatRunOptions,
): Promise<string> {
  const { settings, mode } = carriedGrants(options.carried);
  return run(turns, {
    args: chatArgs(
      model,
      options.effort,
      options.webSearch,
      !!options.askPermission,
      // The person's pick, or what they let an earlier run switch to.
      options.permissionMode ?? mode,
      settings,
    ),
    // Where a terminal opens.
    cwd: homedir(),
    env: claudeEnv(options.effort),
    abortSignal: options.abortSignal,
    onText: options.onText,
    onSource: options.onSource,
    askPermission: options.askPermission,
  });
}

/* ---------------------------------------------------------------- models */

/** Claude Code's --effort levels, plus turning thinking off. */
const REASONING: ModelReasoning = {
  efforts: ["none", "low", "medium", "high", "xhigh", "max"],
  defaultEffort: null,
};

const claudeModel = (id: string, name: string): ChatModel => ({
  id,
  name,
  contextTokens: 200_000,
  maxOutputTokens: null,
  acceptsImages: true,
  released: null,
  aliases: [],
  replacedBy: null,
  retires: null,
  pricing: null,
  reasoning: REASONING,
  searchesWeb: true,
});

/**
 * The models Claude Code runs, by the aliases it resolves to the newest of
 * each family, so the list doesn't go stale as models are released. Whether
 * the user's plan includes one only shows when it's used. None has a price:
 * the user's Claude subscription covers them.
 */
const CHAT_MODELS: readonly ChatModel[] = [
  claudeModel("opus", "Claude Opus"),
  claudeModel("sonnet", "Claude Sonnet"),
  claudeModel("haiku", "Claude Haiku"),
];

export const claudeCode: ChatAdapter = {
  name: "Claude Code",
  serves: (modelId) => CHAT_MODELS.some((model) => model.id === modelId),

  async connect() {
    const status = JSON.parse(await runCommand(["auth", "status"])) as {
      loggedIn?: boolean;
    };
    if (!status.loggedIn) {
      throw new ClaudeCodeError("Claude Code isn't logged in; run `claude`");
    }
    // At no effort, a short answer like a title takes about two seconds
    // instead of six.
    return {
      models: [...CHAT_MODELS],
      helper: { model: "haiku", effort: "none" },
    };
  },

  chat,

  helper: (model, instructions, prompt, { abortSignal, effort }) =>
    run([{ role: "user", content: prompt }], {
      args: helperArgs(model, instructions, effort),
      cwd: tmpdir(),
      env: claudeEnv(effort),
      abortSignal,
      onText: () => {},
      onSource: () => {},
      askPermission: undefined,
    }),
};
