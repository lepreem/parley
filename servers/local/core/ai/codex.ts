import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { getBaseEnv } from "../env";

/**
 * Chat on the user's own Codex, the way chat runs on their Claude Code: each
 * call is one `codex app-server` run, which answers on their ChatGPT plan
 * rather than on an API key. The app server speaks JSON-RPC, one message a
 * line, over stdin and stdout.
 */

/** Codex couldn't answer; the message is what it said went wrong. */
class CodexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexError";
  }
}

/** A part of the one message a run is handed: text, or an image in place. */
export type CodexPromptPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

/** A model in the user's Codex catalog, as the app lists it. */
export type CodexModel = {
  id: string;
  name: string;
  acceptsImages: boolean;
  isDefault: boolean;
};

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

/**
 * The thread's settings that turn Codex's coding agent into a plain chat
 * model: no shell, web search, apps, plugins, skills, sub-agents, hooks,
 * memories or AGENTS.md files, none of the coding agent's own instructions,
 * nothing it may write to, and nothing saved as a session. The app keeps the
 * history. The user's MCP servers are turned off by name (`chatConfig`).
 */
const CHAT_CONFIG = {
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

/**
 * CHAT_CONFIG with each of the user's MCP servers turned off: an empty
 * `mcp_servers` would be merged into theirs rather than replace it.
 */
async function chatConfig(server: AppServer) {
  const { config } = (await server.request("config/read", {
    cwd: tmpdir(),
  })) as { config: { mcp_servers?: Record<string, unknown> | null } };
  const mcpServers = Object.fromEntries(
    Object.keys(config.mcp_servers ?? {}).map((name) => [
      name,
      { enabled: false },
    ]),
  );
  return { ...CHAT_CONFIG, mcp_servers: mcpServers };
}

/** What a turn may produce besides its answer; anything else is a tool. */
const CHAT_ITEMS = new Set(["userMessage", "agentMessage", "reasoning"]);

/**
 * One `codex app-server` run. `request` sends a request and reads up to its
 * response; `next` reads the next notification. Requests the server makes of
 * the app (approvals, questions) are refused, since a chat has nothing to
 * approve.
 */
function startAppServer(signal?: AbortSignal) {
  const child = spawn(getBaseEnv().CODEX_PATH, ["app-server"], {
    // Codex tells the model which folder it runs in, and the app's own would
    // steer answers towards it; the temp folder says nothing.
    cwd: tmpdir(),
    stdio: ["pipe", "pipe", "pipe"],
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
  const send = (message: object) =>
    child.stdin.write(`${JSON.stringify(message)}\n`);

  /** Why the run ended before it was done. */
  async function endedEarly(): Promise<never> {
    const code = await closed;
    if (signal?.aborted) throw signal.reason;
    if (failure) throw failure;
    throw new CodexError(stderr.trim() || `codex exited with code ${code}`);
  }

  /** The next message that isn't a request of the app's, which it refuses. */
  async function read(): Promise<RpcMessage> {
    for (;;) {
      const { value, done } = await lines.next();
      if (done) return endedEarly();
      const message = JSON.parse(value) as RpcMessage;
      if (message.method && message.id !== undefined) {
        send({
          id: message.id,
          error: { code: -32601, message: "Not available in a chat" },
        });
        continue;
      }
      return message;
    }
  }

  let lastId = 0;
  return {
    async request(method: string, params: object) {
      const id = ++lastId;
      send({ id, method, params });
      for (;;) {
        const message = await read();
        if (message.id !== id) continue;
        if (message.error) {
          throw new CodexError(message.error.message ?? `${method} failed`);
        }
        return message.result ?? {};
      }
    },

    /** The next notification: a message with a method and no id. */
    async next(): Promise<{ method: string; params: Record<string, unknown> }> {
      for (;;) {
        const message = await read();
        if (message.method) {
          return { method: message.method, params: message.params ?? {} };
        }
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

/**
 * Startup health check and catalog: fails if Codex can't be run or isn't
 * logged in, and otherwise resolves with the models the user's plan offers.
 */
export async function connectCodex(): Promise<CodexModel[]> {
  const server = startAppServer();
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

    const models: CodexModel[] = [];
    let cursor: string | null = null;
    do {
      const page = (await server.request("model/list", { cursor })) as {
        data: {
          id: string;
          displayName: string;
          hidden: boolean;
          inputModalities: string[];
          isDefault: boolean;
        }[];
        nextCursor: string | null;
      };
      for (const model of page.data) {
        if (model.hidden) continue;
        models.push({
          id: model.id,
          name: model.displayName,
          acceptsImages: model.inputModalities.includes("image"),
          isDefault: model.isDefault,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return models;
  } finally {
    server.close();
  }
}

/**
 * Runs one turn on Codex, passing each piece of the answer's text to `onText`
 * as it arrives, and resolving with the whole answer. Aborting `abortSignal`
 * kills the run and rejects with the signal's reason.
 */
export async function runCodexChat(
  model: string,
  prompt: readonly CodexPromptPart[],
  {
    abortSignal,
    onText,
    thinking,
    instructions,
  }: {
    abortSignal: AbortSignal;
    onText: (text: string) => void | Promise<void>;
    thinking: boolean;
    instructions: string;
  },
): Promise<string> {
  const server = startAppServer(abortSignal);
  try {
    await server.initialize();
    const { thread } = (await server.request("thread/start", {
      model,
      cwd: tmpdir(),
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      baseInstructions: instructions,
      config: await chatConfig(server),
    })) as { thread: { id: string } };

    await server.request("turn/start", {
      threadId: thread.id,
      input: prompt.map((part) =>
        part.type === "text"
          ? { type: "text", text: part.text, text_elements: [] }
          : { type: "image", url: `data:${part.mimeType};base64,${part.data}` },
      ),
      // Every Codex model reasons; low is the least it takes.
      ...(thinking ? {} : { effort: "low" }),
    });

    let answer = "";
    let answerItemId: unknown;
    let lastError: string | undefined;
    for (;;) {
      const { method, params } = await server.next();

      if (method === "item/agentMessage/delta") {
        const delta = params.delta as string;
        if (!delta) continue;
        // A second message in one turn starts a new paragraph.
        if (answer && params.itemId !== answerItemId) {
          answer += "\n\n";
          await onText("\n\n");
        }
        answerItemId = params.itemId;
        answer += delta;
        await onText(delta);
      } else if (method === "item/started") {
        // CHAT_CONFIG leaves it nothing that acts on this machine: what the
        // model catalog still offers (a JavaScript sandbox, sub-agents) can't
        // write, and sub-agents can't start in an ephemeral thread. If a
        // tool turns up anyway, the turn ends here.
        const type = (params.item as { type: string }).type;
        if (!CHAT_ITEMS.has(type)) {
          throw new CodexError(`Codex tried to use a tool (${type})`);
        }
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
    // Whatever stopped reading the answer, the run doesn't outlive it.
    server.close();
  }
}
