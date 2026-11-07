import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import type {
  ChatModel,
  PermissionMode,
  ReasoningEffort,
} from "@parley/contract";
import { withTimeout } from "@parley/server-kit/runtime/withTimeout";
import { getBaseEnv } from "../env";
import {
  CHAT_INSTRUCTIONS,
  type ChatCatalog,
  conversationAsOneMessage,
  parseJsonLine,
  programEnv,
  type AskPermission,
  type ChatAdapter,
  type ChatRunOptions,
  type ChatTurn,
  type PermissionAnswer,
  type PermissionRequest,
} from "./chatAdapter";

/**
 * Chat on the user's own Codex, the way chat runs on their Claude Code: each
 * call is one `codex app-server` run, which answers on their ChatGPT plan
 * rather than on an API key. The app server speaks JSON-RPC, one message a
 * line, over stdin and stdout. Its protocol is Codex's own, marked
 * experimental: an update can change it, and this file is where it shows.
 */

/** Codex couldn't answer; the message is what it said went wrong. */
class CodexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexError";
  }
}

/** Codex's model ids, kept apart from Claude Code's in the app's catalog. */
const PREFIX = "codex/";

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

type Notification = { method: string; params: Record<string, unknown> };

/** A request Codex makes of the app mid-run, answered with `result`. */
type ServerRequest = {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
};

/** An error answer to a server request, which Codex hands the model. */
class RequestRefused extends Error {}

/**
 * One `codex app-server` run. `request` sends a request and reads up to its
 * response; `next` reads the next notification, including any that came
 * before that response. Requests the server makes of the app go to
 * `onRequest`, which answers in its own time.
 */
function startAppServer({
  cwd,
  signal,
  onRequest,
}: {
  cwd: string;
  signal: AbortSignal;
  onRequest: (request: ServerRequest) => Promise<unknown>;
}) {
  const child = spawn(getBaseEnv().CODEX_PATH, ["app-server"], {
    windowsHide: true,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: programEnv(),
    signal,
  });

  // A run that can't start, or is killed, reports why here; it still closes.
  let failure: unknown;
  child.on("error", (error) => (failure ??= error));
  const closed = new Promise<number | null>((resolve) =>
    child.on("close", resolve),
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  child.stdin.on("error", () => {});

  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  const send = (message: object) => {
    if (!child.stdin.writableEnded) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  };

  /** Why the run ended before it was done. */
  async function endedEarly(): Promise<never> {
    const code = await closed;
    if (signal.aborted) throw signal.reason;
    if (failure) throw failure;
    throw new CodexError(stderr.trim() || `codex exited with code ${code}`);
  }

  function answer(request: ServerRequest) {
    onRequest(request).then(
      (result) => send({ id: request.id, result }),
      (error: unknown) =>
        send({
          id: request.id,
          error: {
            code: error instanceof RequestRefused ? -32000 : -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        }),
    );
  }

  /** The next message that isn't a request of the app's, which is answered. */
  async function read(): Promise<RpcMessage> {
    for (;;) {
      const { value, done } = await lines.next();
      if (done) return endedEarly();
      const message = parseJsonLine<RpcMessage>(value);
      if (!message) continue;
      if (message.method && message.id !== undefined) {
        answer({
          id: message.id,
          method: message.method,
          params: message.params ?? {},
        });
        continue;
      }
      return message;
    }
  }

  const notifications: Notification[] = [];
  const notificationOf = (message: RpcMessage): Notification | undefined =>
    message.method
      ? { method: message.method, params: message.params ?? {} }
      : undefined;

  let lastId = 0;
  return {
    async request(method: string, params: object) {
      const id = ++lastId;
      send({ id, method, params });
      for (;;) {
        const message = await read();
        if (message.id !== id) {
          const notification = notificationOf(message);
          if (notification) notifications.push(notification);
          continue;
        }
        if (message.error) {
          throw new CodexError(message.error.message ?? `${method} failed`);
        }
        return message.result ?? {};
      }
    },

    /** The next notification: a message with a method and no id. */
    async next(): Promise<Notification> {
      const queued = notifications.shift();
      if (queued) return queued;
      for (;;) {
        const notification = notificationOf(await read());
        if (notification) return notification;
      }
    },

    async initialize() {
      await this.request("initialize", {
        clientInfo: { name: "parley", title: "Parley", version: "1.0.0" },
        capabilities: null,
      });
      send({ method: "initialized" });
    },

    close() {
      if (child.exitCode === null) child.kill();
    },
  };
}

type AppServer = ReturnType<typeof startAppServer>;

/** Answers a helper run's requests: it has nothing to approve. */
const refuseAll = async (): Promise<never> => {
  throw new RequestRefused("Not available here");
};

/* ---------------------------------------------------------------- models */

/** Codex's reasoning efforts that the app's picker knows, least first. */
const EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

type CodexModel = {
  id: string;
  displayName: string;
  hidden: boolean;
  inputModalities: string[];
  isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: string }[];
  defaultReasoningEffort: string;
};

const asEffort = (effort: string): ReasoningEffort | undefined =>
  EFFORTS.find((known) => known === effort);

function chatModelOf(model: CodexModel): ChatModel {
  const efforts = EFFORTS.filter((effort) =>
    model.supportedReasoningEfforts.some(
      ({ reasoningEffort }) => reasoningEffort === effort,
    ),
  );
  return {
    id: `${PREFIX}${model.id}`,
    name: model.displayName,
    contextTokens: null,
    maxOutputTokens: null,
    acceptsImages: model.inputModalities.includes("image"),
    released: null,
    aliases: [],
    replacedBy: null,
    retires: null,
    // The user's ChatGPT plan covers them.
    pricing: null,
    reasoning: {
      efforts,
      defaultEffort: asEffort(model.defaultReasoningEffort) ?? null,
    },
    searchesWeb: true,
  };
}

// Listing the models can fetch the catalog; a Codex that hangs mustn't hold
// up a startup that could chat on Claude Code.
const CONNECT_TIMEOUT_MS = 30 * 1000; // 30 seconds

async function listModels(signal: AbortSignal): Promise<ChatCatalog> {
  const server = startAppServer({
    cwd: tmpdir(),
    signal,
    onRequest: refuseAll,
  });
  try {
    await server.initialize();
    // A provider of the user's own, set in their config, may need no account.
    const { account, requiresOpenaiAuth } = (await server.request(
      "account/read",
      { refreshToken: false },
    )) as { account: unknown; requiresOpenaiAuth: boolean };
    if (!account && requiresOpenaiAuth) {
      throw new CodexError("Codex isn't logged in; run `codex login`");
    }

    const models: ChatModel[] = [];
    let defaultModel: ChatModel | undefined;
    let cursor: string | null = null;
    do {
      const page = (await server.request("model/list", { cursor })) as {
        data: CodexModel[];
        nextCursor: string | null;
      };
      for (const model of page.data) {
        if (model.hidden) continue;
        const chatModel = chatModelOf(model);
        models.push(chatModel);
        if (model.isDefault) defaultModel = chatModel;
      }
      cursor = page.nextCursor;
    } while (cursor);
    const helperModel = defaultModel ?? models[0];
    if (!helperModel) throw new CodexError("Codex lists no models");
    return {
      models,
      // Codex's own default model, at its least effort, when it's the only
      // program there is.
      helper: {
        model: helperModel.id,
        effort: helperModel.reasoning?.efforts[0],
      },
    };
  } finally {
    server.close();
  }
}

/* ---------------------------------------------------- permission prompts */

/** What a conversation's earlier runs were allowed for their session. */
type Carried =
  { type: "command"; command: string } | { type: "mode"; mode: PermissionMode };

const DECLINED_WITHOUT_ASKING = "Nothing in the app can answer this.";
/** Codex's question tool needs an answer the app has no screen for. */
const ASK_IN_REPLY =
  "This app can't show that tool. Ask in your reply instead, and the person will answer in their next message.";

/**
 * The thread's settings for what the person picked under the message box. Left
 * out, the person's own Codex config decides, as in their terminal.
 */
function permissionsOf(mode: PermissionMode | undefined) {
  if (mode === "acceptEdits") return { sandbox: "workspace-write" };
  if (mode === "bypassPermissions") {
    return { sandbox: "danger-full-access", approvalPolicy: "never" };
  }
  return {};
}

/** A file change, as the person sees it: each file and its diff. */
type FileChange = { path: string; diff: string };

const detailOfChanges = (changes: readonly FileChange[]) =>
  changes.map(({ path, diff }) => `${path}\n${diff}`).join("\n\n");

/**
 * Answers Codex's requests of a chat turn: its approvals go to the person as
 * the same cards Claude Code's do, and what has no card is refused in a way
 * the model can explain.
 */
function chatRequests({
  askPermission,
  carried,
  fileChanges,
  waiting,
}: {
  askPermission: AskPermission | undefined;
  carried: readonly Carried[];
  /** The changes each file-change item would make, by item, as Codex announced them. */
  fileChanges: Map<string, FileChange[]>;
  /** The approvals Codex is waiting on, by request, so it can take one back. */
  waiting: Map<string, AbortController>;
}) {
  async function ask(
    id: number | string,
    request: PermissionRequest,
  ): Promise<PermissionAnswer> {
    if (!askPermission) {
      return { decision: "deny", message: DECLINED_WITHOUT_ASKING };
    }
    const controller = new AbortController();
    waiting.set(String(id), controller);
    try {
      return await askPermission(request, controller.signal);
    } finally {
      waiting.delete(String(id));
    }
  }

  return async ({ id, method, params }: ServerRequest): Promise<unknown> => {
    if (method === "item/commandExecution/requestApproval") {
      const command = typeof params.command === "string" ? params.command : "";
      if (
        carried.some(
          (grant) => grant.type === "command" && grant.command === command,
        )
      ) {
        return { decision: "accept" };
      }
      const amendment = Array.isArray(params.proposedExecpolicyAmendment)
        ? (params.proposedExecpolicyAmendment as string[])
        : undefined;
      const answer = await ask(id, {
        program: "Codex",
        toolName: "Command",
        detail: command || JSON.stringify(params, null, 2),
        // Codex's "don't ask again": a rule saved to its own config, or this
        // command for as long as a terminal session would last.
        always: amendment
          ? { label: "Always allow", rules: [amendment.join(" ")], mode: null }
          : { label: "Allow in this chat", rules: [], mode: null },
        carry: amendment || !command ? [] : [{ type: "command", command }],
      });
      if (answer.decision === "deny") return { decision: "decline" };
      if (answer.decision === "allow") return { decision: "accept" };
      return {
        decision: amendment
          ? {
              acceptWithExecpolicyAmendment: {
                execpolicy_amendment: amendment,
              },
            }
          : "acceptForSession",
      };
    }

    if (method === "item/fileChange/requestApproval") {
      if (carried.some((grant) => grant.type === "mode")) {
        return { decision: "accept" };
      }
      const changes = fileChanges.get(String(params.itemId)) ?? [];
      const answer = await ask(id, {
        program: "Codex",
        toolName: "Edit",
        detail:
          detailOfChanges(changes) ||
          (typeof params.reason === "string" ? params.reason : "A file change"),
        always: { label: "Allow all edits", rules: [], mode: "acceptEdits" },
        carry: [{ type: "mode", mode: "acceptEdits" }],
      });
      if (answer.decision === "deny") return { decision: "decline" };
      return {
        decision: answer.decision === "always" ? "acceptForSession" : "accept",
      };
    }

    if (method === "item/permissions/requestApproval") {
      const requested = (params.permissions ?? {}) as {
        network?: unknown;
        fileSystem?: unknown;
      };
      const answer = await ask(id, {
        program: "Codex",
        toolName: "Permissions",
        detail: [
          typeof params.reason === "string" ? params.reason : "",
          JSON.stringify(requested, null, 2),
        ]
          .filter(Boolean)
          .join("\n\n"),
        always: null,
        carry: [],
      });
      if (answer.decision === "deny") return { permissions: {}, scope: "turn" };
      return {
        permissions: {
          ...(requested.network ? { network: requested.network } : {}),
          ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
        },
        scope: "turn",
      };
    }

    if (method === "item/tool/requestUserInput") {
      throw new RequestRefused(ASK_IN_REPLY);
    }
    if (method === "mcpServer/elicitation/request") {
      return { action: "decline", content: null, _meta: null };
    }
    throw new RequestRefused(`Not supported: ${method}`);
  };
}

/* ------------------------------------------------------------------ runs */

/** The conversation as the input of the one turn Codex takes. */
function inputOf(turns: readonly ChatTurn[]) {
  return conversationAsOneMessage(turns).map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text, text_elements: [] }
      : { type: "image", url: `data:${part.mimeType};base64,${part.data}` },
  );
}

/** Hands over the pages one web search lists or reads. */
function readSources(
  item: { results?: unknown; action?: { type?: string; url?: unknown } | null },
  onSource: (url: unknown, title: unknown) => void,
) {
  if (Array.isArray(item.results)) {
    for (const result of item.results as { url?: unknown; title?: unknown }[]) {
      if (typeof result === "object" && result !== null) {
        onSource(result.url, result.title);
      }
    }
  }
  if (item.action?.type === "openPage") onSource(item.action.url, undefined);
}

type TurnSettings = {
  model: string;
  turns: readonly ChatTurn[];
  thread: Record<string, unknown>;
  cwd: string;
  effort: ReasoningEffort | undefined;
  abortSignal: AbortSignal;
  onText: (text: string) => void | Promise<void>;
  onSource: (url: unknown, title: unknown) => void;
  onRequest: (request: ServerRequest) => Promise<unknown>;
  fileChanges: Map<string, FileChange[]>;
  waiting: Map<string, AbortController>;
};

/**
 * Runs one turn on Codex, passing each piece of the answer's text to `onText`
 * as it arrives, and resolving with the whole answer. Aborting `abortSignal`
 * kills the run and rejects with the signal's reason.
 */
async function runTurn(settings: TurnSettings): Promise<string> {
  const { abortSignal, onText, onSource, fileChanges, waiting } = settings;
  const server: AppServer = startAppServer({
    cwd: settings.cwd,
    signal: abortSignal,
    onRequest: settings.onRequest,
  });
  try {
    await server.initialize();
    const { thread } = (await server.request("thread/start", {
      model: settings.model.slice(PREFIX.length),
      cwd: settings.cwd,
      ...settings.thread,
    })) as { thread: { id: string } };

    await server.request("turn/start", {
      threadId: thread.id,
      input: inputOf(settings.turns),
      ...(settings.effort === undefined ? {} : { effort: settings.effort }),
    });

    let answer = "";
    let answerItemId: unknown;
    let lastError: string | undefined;
    for (;;) {
      const { method, params } = await server.next();

      if (method === "item/agentMessage/delta") {
        const delta = params.delta as string;
        if (!delta) continue;
        // A second message in one turn, as after a tool, is a new paragraph.
        const text = `${answer && params.itemId !== answerItemId ? "\n\n" : ""}${delta}`;
        answerItemId = params.itemId;
        answer += text;
        await onText(text);
      } else if (method === "item/started" || method === "item/completed") {
        const item = params.item as {
          type: string;
          id: string;
          changes?: FileChange[];
        };
        if (item.type === "fileChange") {
          fileChanges.set(item.id, item.changes ?? []);
        } else if (item.type === "webSearch" && method === "item/completed") {
          readSources(item as Parameters<typeof readSources>[0], onSource);
        }
      } else if (method === "serverRequest/resolved") {
        // Codex stopped waiting, as when the turn was interrupted.
        waiting.get(String(params.requestId))?.abort();
      } else if (method === "error") {
        // Codex reports each retry here, then the last error with the turn.
        lastError = (params.error as { message: string }).message;
      } else if (method === "turn/completed") {
        const turn = params.turn as {
          status: string;
          error: { message: string } | null;
        };
        if (turn.status === "completed") return answer;
        throw new CodexError(
          turn.error?.message ?? lastError ?? `Codex turn ${turn.status}`,
        );
      }
    }
  } finally {
    // Whatever stopped reading the answer, the run doesn't outlive it, and
    // nobody is left being asked on its behalf.
    for (const controller of waiting.values()) controller.abort();
    server.close();
  }
}

function chat(
  model: string,
  turns: readonly ChatTurn[],
  options: ChatRunOptions,
): Promise<string> {
  const carried = options.carried as Carried[];
  const carriedMode = carried.find(
    (grant): grant is Extract<Carried, { type: "mode" }> =>
      grant.type === "mode",
  )?.mode;
  const fileChanges = new Map<string, FileChange[]>();
  const waiting = new Map<string, AbortController>();

  return runTurn({
    model,
    turns,
    // Where a terminal opens.
    cwd: homedir(),
    thread: {
      // Added to Codex's own instructions, as Claude Code's are appended to.
      developerInstructions: CHAT_INSTRUCTIONS,
      config: { web_search: options.webSearch ? "live" : "disabled" },
      // The person's pick, or what they let an earlier run switch to.
      ...permissionsOf(options.permissionMode ?? carriedMode),
    },
    effort: options.effort,
    abortSignal: options.abortSignal,
    onText: options.onText,
    onSource: options.onSource,
    onRequest: chatRequests({
      askPermission: options.askPermission,
      carried,
      fileChanges,
      waiting,
    }),
    fileChanges,
    waiting,
  });
}

/**
 * The thread settings that make Codex a plain model for the app's own small
 * jobs: no shell, web search, apps, plugins, skills, sub-agents, hooks,
 * memories or AGENTS.md files, nothing it may write to, and nothing saved as
 * a session. The person's MCP servers are turned off by name in `helper`.
 */
const HELPER_CONFIG = {
  web_search: "disabled",
  project_doc_max_bytes: 0,
  include_permissions_instructions: false,
  include_environment_context: false,
  include_collaboration_mode_instructions: false,
  include_skills_usage_instructions: false,
  include_apps_instructions: false,
  include_plugin_usage_instructions: false,
  skills: { bundled: { enabled: false }, include_instructions: false },
  features: {
    multi_agent: false,
    code_mode_host: false,
    sleep_tool: false,
    view_image: false,
    shell_tool: false,
    unified_exec: false,
    apps: false,
    plugins: false,
    image_generation: false,
    browser_use: false,
    computer_use: false,
    in_app_browser: false,
    memories: false,
    goals: false,
    hooks: false,
    tool_suggest: false,
    skill_search: false,
  },
};

/** The person's MCP server names, so a helper run can turn each one off. */
async function mcpServerNames(signal: AbortSignal): Promise<string[]> {
  const server = startAppServer({
    cwd: tmpdir(),
    signal,
    onRequest: refuseAll,
  });
  try {
    await server.initialize();
    const { config } = (await server.request("config/read", {
      cwd: tmpdir(),
    })) as { config: { mcp_servers?: Record<string, unknown> | null } };
    return Object.keys(config.mcp_servers ?? {});
  } finally {
    server.close();
  }
}

export const codex: ChatAdapter = {
  name: "Codex",
  serves: (modelId) => modelId.startsWith(PREFIX),

  connect: () =>
    withTimeout({ timeoutMs: CONNECT_TIMEOUT_MS }, ({ abortSignal }) =>
      listModels(abortSignal),
    ),

  chat,

  async helper(model, instructions, prompt, { abortSignal, effort }) {
    // An empty `mcp_servers` would be merged into theirs rather than replace it.
    const mcpServers = Object.fromEntries(
      (await mcpServerNames(abortSignal)).map((name) => [
        name,
        { enabled: false },
      ]),
    );
    return runTurn({
      model,
      turns: [{ role: "user", content: prompt }],
      // Codex tells the model which folder it runs in; the temp folder says nothing.
      cwd: tmpdir(),
      thread: {
        ephemeral: true,
        sandbox: "read-only",
        approvalPolicy: "never",
        baseInstructions: instructions,
        config: { ...HELPER_CONFIG, mcp_servers: mcpServers },
      },
      effort,
      abortSignal,
      onText: () => {},
      onSource: () => {},
      onRequest: refuseAll,
      fileChanges: new Map(),
      waiting: new Map(),
    });
  },
};
