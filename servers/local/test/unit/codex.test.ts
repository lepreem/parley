import { tmpdir } from "node:os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fakeProcess, spawned } from "../helpers/fakeProcess";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

import {
  buildUserTurn,
  chatAI,
  findChatModel,
  generateTitle,
  listChatModels,
  pingChatAI,
} from "../../core/ai/ai_chat_client";

type Line = Record<string, unknown>;
type Spawn = ReturnType<typeof fakeProcess>;

/** A program that isn't installed: it fails to start, as Node reports it. */
const notInstalled: Spawn = (command, args, options) => {
  const child = fakeProcess([], { end: false })(command, args, options);
  setImmediate(() => {
    child.emit(
      "error",
      Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" }),
    );
    child.kill();
  });
  return child;
};

const claudeLoggedIn = fakeProcess([
  { line: { loggedIn: true, authMethod: "claude.ai" } },
]);

/** Runs `claude` and `codex` as these fakes, each run spawning afresh. */
function programs({
  claude = notInstalled,
  codex = notInstalled,
}: {
  claude?: Spawn;
  codex?: Spawn;
}) {
  mockSpawn.mockImplementation(
    (command: string, args: string[], options: { signal?: AbortSignal }) =>
      (command === "codex" ? codex : claude)(command, args, options),
  );
}

/** Codex's app server, answering requests in order with these lines. */
const codexServer = (lines: Line[], options?: { end?: boolean }) =>
  fakeProcess(
    lines.map((line) => ({ line })),
    options,
  );

const response = (id: number, result: Line = {}): Line => ({ id, result });

const catalogModel = (id: string, extra: Line = {}): Line => ({
  id,
  displayName: id.toUpperCase(),
  hidden: false,
  inputModalities: ["text", "image"],
  isDefault: false,
  supportedReasoningEfforts: [
    { reasoningEffort: "low" },
    { reasoningEffort: "medium" },
    { reasoningEffort: "high" },
  ],
  ...extra,
});

/** A logged-in Codex whose catalog is these pages of models. */
const codexWithCatalog = (...pages: Line[][]) =>
  codexServer([
    response(1),
    response(2, { account: { type: "chatgpt" }, requiresOpenaiAuth: true }),
    ...pages.map((data, index) =>
      response(3 + index, {
        data,
        nextCursor: index < pages.length - 1 ? `page${index + 1}` : null,
      }),
    ),
  ]);

const CATALOG = [
  catalogModel("gpt-5.5", { isDefault: true }),
  catalogModel("gpt-5.5-mini", {
    inputModalities: ["text"],
    supportedReasoningEfforts: [
      { reasoningEffort: "minimal" },
      { reasoningEffort: "low" },
    ],
  }),
];

/** Codex's lines up to the turn's start: what every chat begins with. */
const turnStarted = (mcpServers: Line = {}): Line[] => [
  response(1),
  response(2, { config: { mcp_servers: mcpServers } }),
  response(3, { thread: { id: "thread-1" } }),
  response(4, { turn: { id: "turn-1", status: "inProgress" } }),
];

const delta = (text: string, itemId = "msg-1"): Line => ({
  method: "item/agentMessage/delta",
  params: { threadId: "thread-1", turnId: "turn-1", itemId, delta: text },
});

const itemStarted = (type: string): Line => ({
  method: "item/started",
  params: { item: { type, id: "item-1" } },
});

const turnCompleted = (
  status = "completed",
  error: { message: string } | null = null,
): Line => ({
  method: "turn/completed",
  params: { threadId: "thread-1", turn: { id: "turn-1", status, error } },
});

/** A chat whose answer is these lines, after the turn starts. */
const codexChat = (lines: Line[], options?: { end?: boolean }) =>
  codexServer([...turnStarted(), ...lines], options);

/** The requests the app sent the `n`th run, by method. */
function requestsOf(n: number) {
  const messages = spawned(mockSpawn, n)
    .child.input()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Line);
  return (method: string) =>
    messages.find((message) => message.method === method) as
      { id?: number; params: Record<string, unknown> } | undefined;
}

const codexRuns = () =>
  mockSpawn.mock.calls.flatMap((call, n) => (call[0] === "codex" ? [n] : []));

/** Startup, with both Claude Code and Codex logged in. */
async function startWithBoth() {
  programs({ claude: claudeLoggedIn, codex: codexWithCatalog(CATALOG) });
  await pingChatAI();
  mockSpawn.mockReset();
}

beforeEach(() => {
  mockSpawn.mockReset();
});

describe("pingChatAI with Codex", () => {
  it("starts Codex's app server outside the app's folder", async () => {
    programs({ claude: claudeLoggedIn, codex: codexWithCatalog(CATALOG) });

    await pingChatAI();

    const [run] = codexRuns();
    const { args, options } = spawned(mockSpawn, run);
    expect(args).toEqual(["app-server"]);
    expect(options.cwd).toBe(tmpdir());
    expect(requestsOf(run ?? -1)("initialized")).toBeDefined();
  });

  it("lists both Claude Code's models and the Codex catalog's", async () => {
    programs({
      claude: claudeLoggedIn,
      codex: codexWithCatalog(CATALOG, [
        catalogModel("gpt-5.4"),
        catalogModel("internal-only", { hidden: true }),
      ]),
    });

    await pingChatAI();

    expect(await listChatModels()).toEqual([
      expect.objectContaining({ id: "opus" }),
      expect.objectContaining({ id: "sonnet" }),
      expect.objectContaining({ id: "haiku" }),
      {
        id: "codex/gpt-5.5",
        name: "Codex: GPT-5.5",
        contextTokens: null,
        acceptsImages: true,
        pricing: null,
      },
      {
        id: "codex/gpt-5.5-mini",
        name: "Codex: GPT-5.5-MINI",
        contextTokens: null,
        acceptsImages: false,
        pricing: null,
      },
      expect.objectContaining({ id: "codex/gpt-5.4" }),
    ]);
    const [run] = codexRuns();
    expect(requestsOf(run ?? -1)("model/list")?.params).toEqual({
      cursor: null,
    });
  });

  it("runs on Codex alone when Claude Code isn't installed", async () => {
    programs({ codex: codexWithCatalog(CATALOG) });

    await pingChatAI();

    expect((await listChatModels()).map((model) => model.id)).toEqual([
      "codex/gpt-5.5",
      "codex/gpt-5.5-mini",
    ]);
    expect(await findChatModel("sonnet")).toBeUndefined();
  });

  it("runs on Claude Code alone when Codex isn't logged in", async () => {
    programs({
      claude: claudeLoggedIn,
      codex: codexServer([
        response(1),
        response(2, { account: null, requiresOpenaiAuth: true }),
      ]),
    });

    await pingChatAI();

    expect((await listChatModels()).map((model) => model.id)).toEqual([
      "opus",
      "sonnet",
      "haiku",
    ]);
  });

  it("fails, saying why for each, when neither can chat", async () => {
    programs({
      claude: fakeProcess([{ line: { loggedIn: false } }]),
      codex: codexServer([
        response(1),
        response(2, { account: null, requiresOpenaiAuth: true }),
      ]),
    });

    await expect(pingChatAI()).rejects.toThrow(
      "neither Claude Code nor Codex can chat. Claude Code: Claude Code isn't logged in; run `claude`. Codex: Codex isn't logged in; run `codex login`",
    );
  });

  it("says a program that isn't installed isn't", async () => {
    programs({});

    await expect(pingChatAI()).rejects.toThrow(
      "Claude Code: not installed, or not on PATH. Codex: not installed, or not on PATH",
    );
  });

  it("counts a Codex with no models as unavailable", async () => {
    programs({ codex: codexWithCatalog([]) });

    await expect(pingChatAI()).rejects.toThrow("Codex: Codex lists no models");
  });

  it("accepts a provider of the user's own that needs no account", async () => {
    programs({
      codex: codexServer([
        response(1),
        response(2, { account: null, requiresOpenaiAuth: false }),
        response(3, { data: CATALOG, nextCursor: null }),
      ]),
    });

    await expect(pingChatAI()).resolves.toBeUndefined();
  });

  describe("with a Codex that never answers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("gives up on it after 30 seconds", async () => {
      programs({
        claude: claudeLoggedIn,
        codex: codexServer([], { end: false }),
      });

      const ping = pingChatAI();
      await vi.advanceTimersByTimeAsync(30_000);
      await ping;

      expect((await listChatModels()).map((model) => model.id)).toEqual([
        "opus",
        "sonnet",
        "haiku",
      ]);
    });
  });
});

describe("chatAI on Codex", () => {
  beforeEach(startWithBoth);

  it("runs the model as a plain chat model, with nothing saved", async () => {
    programs({ codex: codexChat([delta("hi"), turnCompleted()]) });

    expect(
      await chatAI("codex/gpt-5.5", [{ role: "user", content: "yo" }]),
    ).toBe("hi");

    const request = requestsOf(0);
    expect(request("thread/start")?.params).toMatchObject({
      model: "gpt-5.5",
      cwd: tmpdir(),
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      config: {
        web_search: "disabled",
        project_doc_max_bytes: 0,
        include_permissions_instructions: false,
        include_environment_context: false,
        features: { shell_tool: false, apps: false, plugins: false },
      },
    });
    expect(request("thread/start")?.params.baseInstructions).toContain(
      "<user>",
    );
    expect(request("turn/start")?.params).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: "<user>\nyo\n</user>", text_elements: [] }],
    });
  });

  it("turns off each of the user's own MCP servers", async () => {
    programs({
      codex: codexServer([
        ...turnStarted({ github: { command: "gh-mcp" }, docs: { url: "x" } }),
        delta("hi"),
        turnCompleted(),
      ]),
    });

    await chatAI("codex/gpt-5.5", [{ role: "user", content: "yo" }]);

    const request = requestsOf(0);
    expect(request("config/read")?.params).toEqual({ cwd: tmpdir() });
    expect(
      (request("thread/start")?.params.config as Line).mcp_servers,
    ).toEqual({ github: { enabled: false }, docs: { enabled: false } });
  });

  it("hands over the conversation with its images in place", async () => {
    programs({ codex: codexChat([delta("Red."), turnCompleted()]) });
    const png = { mimeType: "image/png", data: "cGl4ZWxz" };

    await chatAI("codex/gpt-5.5", [
      buildUserTurn("What is this?", [png]),
      { role: "assistant", content: "A square." },
      { role: "user", content: "What color?" },
    ]);

    expect(requestsOf(0)("turn/start")?.params.input).toEqual([
      { type: "text", text: "<user>\nWhat is this?", text_elements: [] },
      { type: "image", url: "data:image/png;base64,cGl4ZWxz" },
      {
        type: "text",
        text: "\n</user>\n\n<assistant>\nA square.\n</assistant>\n\n<user>\nWhat color?\n</user>",
        text_elements: [],
      },
    ]);
  });

  it("streams the answer's text, a second message as a new paragraph", async () => {
    const deltas: string[] = [];
    programs({
      codex: codexChat([
        { method: "turn/started", params: {} },
        itemStarted("reasoning"),
        itemStarted("agentMessage"),
        delta("Hel"),
        delta("lo"),
        delta(""),
        delta("Bye", "msg-2"),
        turnCompleted(),
      ]),
    });

    const answer = await chatAI(
      "codex/gpt-5.5",
      [{ role: "user", content: "yo" }],
      { onDelta: (text) => void deltas.push(text) },
    );

    expect(answer).toBe("Hello\n\nBye");
    expect(deltas).toEqual(["Hel", "lo", "\n\n", "Bye"]);
  });

  it("keeps what arrives before the turn's start is acknowledged", async () => {
    const [init, config, thread, turn] = turnStarted();
    programs({
      codex: codexServer([
        init!,
        config!,
        thread!,
        delta("Early"),
        turn!,
        delta(" bird"),
        turnCompleted(),
      ]),
    });

    expect(
      await chatAI("codex/gpt-5.5", [{ role: "user", content: "yo" }]),
    ).toBe("Early bird");
  });

  it("refuses whatever the app server asks of the app", async () => {
    programs({
      codex: codexChat([
        { id: 99, method: "item/commandExecution/requestApproval", params: {} },
        delta("hi"),
        turnCompleted(),
      ]),
    });

    await chatAI("codex/gpt-5.5", [{ role: "user", content: "yo" }]);

    const lines = spawned(mockSpawn, 0)
      .child.input()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Line);
    expect(lines).toContainEqual({
      id: 99,
      error: { code: -32601, message: "Not available in a chat" },
    });
  });

  it("ends the turn, and the run, when the model reaches for a tool", async () => {
    programs({
      codex: codexChat([itemStarted("commandExecution")], { end: false }),
    });

    await expect(
      chatAI("codex/gpt-5.5", [{ role: "user", content: "yo" }]),
    ).rejects.toThrow("Codex tried to use a tool (commandExecution)");
    expect(spawned(mockSpawn, 0).child.kill).toHaveBeenCalled();
  });

  it("reasons as much as the model would by default", async () => {
    programs({ codex: codexChat([delta("hi"), turnCompleted()]) });

    await chatAI("codex/gpt-5.5", [{ role: "user", content: "yo" }]);

    expect(requestsOf(0)("turn/start")?.params).not.toHaveProperty("effort");
  });

  it("reasons the least the model can when told not to think", async () => {
    programs({ codex: codexChat([delta("hi"), turnCompleted()]) });

    await chatAI("codex/gpt-5.5", [{ role: "user", content: "yo" }], {
      thinking: false,
    });
    await chatAI("codex/gpt-5.5-mini", [{ role: "user", content: "yo" }], {
      thinking: false,
    });

    expect(requestsOf(0)("turn/start")?.params.effort).toBe("low");
    expect(requestsOf(1)("turn/start")?.params.effort).toBe("minimal");
  });

  it("fails with the turn's own error", async () => {
    programs({
      codex: codexChat([
        { method: "error", params: { error: { message: "Retrying" } } },
        turnCompleted("failed", { message: "You've hit your usage limit." }),
      ]),
    });

    await expect(
      chatAI("codex/gpt-5.5", [{ role: "user", content: "yo" }]),
    ).rejects.toThrow("You've hit your usage limit.");
  });

  it("fails with the last error reported when the turn gives none", async () => {
    programs({
      codex: codexChat([
        { method: "error", params: { error: { message: "Stream lost" } } },
        turnCompleted("failed"),
      ]),
    });

    await expect(
      chatAI("codex/gpt-5.5", [{ role: "user", content: "yo" }]),
    ).rejects.toThrow("Stream lost");
  });

  it("fails with a request's error", async () => {
    programs({
      codex: codexServer([
        response(1),
        response(2, { config: {} }),
        { id: 3, error: { code: -32600, message: "Unknown model gpt-0" } },
      ]),
    });

    await expect(
      chatAI("codex/gpt-0", [{ role: "user", content: "yo" }]),
    ).rejects.toThrow("Unknown model gpt-0");
  });

  it("fails with what codex printed when it exits without an answer", async () => {
    programs({
      codex: fakeProcess(
        turnStarted().map((line) => ({ line })),
        { code: 1, stderr: "Token expired\n" },
      ),
    });

    await expect(
      chatAI("codex/gpt-5.5", [{ role: "user", content: "yo" }]),
    ).rejects.toThrow("Token expired");
  });

  it("stops the run when the caller stops reading", async () => {
    programs({ codex: codexChat([delta("Hel")], { end: false }) });

    await expect(
      chatAI("codex/gpt-5.5", [{ role: "user", content: "yo" }], {
        onDelta: () => {
          throw new Error("client gone");
        },
      }),
    ).rejects.toThrow("client gone");
    expect(spawned(mockSpawn, 0).child.kill).toHaveBeenCalled();
  });

  it("stops the run when the caller aborts", async () => {
    programs({ codex: codexChat([], { end: false }) });
    const controller = new AbortController();

    const chat = chatAI("codex/gpt-5.5", [{ role: "user", content: "yo" }], {
      signal: controller.signal,
    });
    controller.abort(new Error("stopped"));

    await expect(chat).rejects.toThrow("stopped");
    expect(spawned(mockSpawn, 0).options.signal?.aborted).toBe(true);
  });
});

describe("generateTitle without Claude Code", () => {
  it("asks Codex's default model, reasoning the least it can", async () => {
    programs({ codex: codexWithCatalog(CATALOG) });
    await pingChatAI();
    mockSpawn.mockReset();
    programs({
      codex: codexChat([delta("Quarterly planning"), turnCompleted()]),
    });

    expect(await generateTitle("conversation", "Plans?")).toBe(
      "Quarterly planning",
    );
    const request = requestsOf(0);
    expect(request("thread/start")?.params.model).toBe("gpt-5.5");
    expect(request("turn/start")?.params.effort).toBe("low");
  });
});
