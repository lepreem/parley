import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  ChatModel,
  PermissionMode,
  ReasoningEffort,
  ToolApproval,
} from "@parley/contract";
import { withTimeout } from "@parley/server-kit/runtime/withTimeout";
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

/** The levels the app offers when Claude Code doesn't list a model's own. */
const EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** A model as Claude Code lists it, as far as it's read here. */
type ListedModel = {
  /** What --model takes: an alias like "opus", or a full model id. */
  value: string;
  /** "Opus 5.5" */
  displayName?: string;
  supportedEffortLevels?: string[];
};

/** A model as the picker shows it, at the effort Claude Code would use. */
function chatModelOf(
  id: string,
  name: string,
  efforts: readonly string[] | undefined,
  defaultEffort: string | undefined,
): ChatModel {
  const levels = EFFORTS.filter(
    (effort) => !efforts || efforts.includes(effort),
  );
  return {
    id,
    name,
    provider: "Claude Code",
    contextTokens: 200_000,
    maxOutputTokens: null,
    acceptsImages: true,
    released: null,
    aliases: [],
    replacedBy: null,
    retires: null,
    // The person's Claude subscription covers them.
    pricing: null,
    reasoning: {
      // Turning thinking off is an environment variable, for any of them.
      efforts: ["none", ...levels],
      defaultEffort: levels.find((effort) => effort === defaultEffort) ?? null,
    },
    searchesWeb: true,
    asksPermission: true,
  };
}

/**
 * What's offered when Claude Code can't say: the aliases it resolves to each
 * family's newest model, so they don't go stale.
 */
const FALLBACK_MODELS: readonly ChatModel[] = [
  chatModelOf("opus", "Claude Opus", undefined, undefined),
  chatModelOf("sonnet", "Claude Sonnet", undefined, undefined),
  chatModelOf("haiku", "Claude Haiku", undefined, undefined),
];

/** The ids `chat` takes: the last list Claude Code gave, or the fallback. */
let offeredIds = new Set(FALLBACK_MODELS.map((model) => model.id));

/** A reply to one of the app's own control requests. */
type ControlReply = {
  subtype: "success" | "error";
  request_id: string;
  response?: unknown;
  error?: string;
};

/**
 * Starts a Claude Code that's never given a message, so it costs nothing and
 * saves no session, and returns a way to ask it things over the same control
 * protocol the Agent SDK uses. It runs where chats do, so it reads the same
 * settings.
 */
function startControlSession(signal: AbortSignal) {
  const child = spawn(
    getBaseEnv().CLAUDE_PATH,
    STREAM_ARGS.filter((arg) => arg !== "--include-partial-messages"),
    {
      windowsHide: true,
      cwd: homedir(),
      stdio: ["pipe", "pipe", "pipe"],
      env: programEnv(),
      signal,
    },
  );
  const waiting = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let stderr = "";
  let ended: Error | undefined;
  const end = (error: Error) => {
    ended ??= error;
    for (const { reject } of waiting.values()) reject(ended);
    waiting.clear();
  };
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  child.stdin.on("error", () => {});
  child.on("error", end);
  child.on("close", (code) =>
    end(
      new ClaudeCodeError(stderr.trim() || `claude exited with code ${code}`),
    ),
  );
  createInterface({ input: child.stdout }).on("line", (line) => {
    const output = parseJsonLine<{ type?: string; response?: ControlReply }>(
      line,
    );
    if (output?.type !== "control_response" || !output.response) return;
    const { request_id, subtype, response, error } = output.response;
    const pending = waiting.get(request_id);
    if (!pending) return;
    waiting.delete(request_id);
    if (subtype === "success") pending.resolve(response ?? {});
    else pending.reject(new ClaudeCodeError(error ?? "Claude Code refused"));
  });

  let sent = 0;
  return {
    ask<T>(request: { subtype: string } & Record<string, unknown>): Promise<T> {
      if (ended) return Promise.reject(ended);
      const id = `parley-${++sent}`;
      return new Promise<T>((resolve, reject) => {
        waiting.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        child.stdin.write(
          `${JSON.stringify({ type: "control_request", request_id: id, request })}\n`,
        );
      });
    },
    close() {
      child.stdin.end();
      if (child.exitCode === null) child.kill();
    },
  };
}

/**
 * The models Claude Code offers by alias ("opus", "sonnet"), which follow
 * each family's newest, and the effort each runs at when none is chosen. That
 * comes from the person's own settings (per model, or for all of them) or
 * Claude Code's default, so it's asked for rather than worked out: the
 * picker can then say "High (default)" rather than just "Default".
 */
async function listModels(signal: AbortSignal): Promise<ChatModel[]> {
  const session = startControlSession(signal);
  try {
    const { models = [] } = await session.ask<{ models?: ListedModel[] }>({
      subtype: "initialize",
    });
    // "default" is whichever of these their settings pick, and full ids
    // ("claude-opus-4-8") are older models the aliases have moved on from.
    const aliases = models.filter(
      ({ value }) => value !== "default" && !value.startsWith("claude-"),
    );
    const listed: ChatModel[] = [];
    for (const model of aliases) {
      await session.ask({ subtype: "set_model", model: model.value });
      const { applied } = await session.ask<{ applied?: { effort?: string } }>({
        subtype: "get_settings",
      });
      listed.push(
        chatModelOf(
          model.value,
          model.displayName ?? model.value,
          model.supportedEffortLevels,
          applied?.effort,
        ),
      );
    }
    return listed;
  } finally {
    session.close();
  }
}

// Asking takes about two seconds; one that hangs mustn't hold up startup.
const LIST_TIMEOUT_MS = 30 * 1000; // 30 seconds

export const claudeCode: ChatAdapter = {
  name: "Claude Code",
  serves: (modelId) => offeredIds.has(modelId),

  async connect() {
    const status = JSON.parse(await runCommand(["auth", "status"])) as {
      loggedIn?: boolean;
    };
    if (!status.loggedIn) {
      throw new ClaudeCodeError("Claude Code isn't logged in; run `claude`");
    }
    // A Claude Code too old to list its models still chats.
    const listed = await withTimeout(
      { timeoutMs: LIST_TIMEOUT_MS },
      ({ abortSignal }) => listModels(abortSignal),
    ).catch(() => []);
    const models = listed.length > 0 ? listed : [...FALLBACK_MODELS];
    offeredIds = new Set(models.map((model) => model.id));
    return {
      models,
      defaultModel: "sonnet",
      // At no effort, a short answer like a title takes about two seconds
      // instead of six.
      helper: { model: "haiku", effort: "none" },
    };
  },

  // Chats run in the home folder, so its project settings are the user's own.
  settingsFiles: () => {
    const folder = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    return [join(folder, "settings.json"), join(folder, "settings.local.json")];
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
