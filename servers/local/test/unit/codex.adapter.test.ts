import { homedir, tmpdir } from "node:os";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fakeAppServer,
  type AppServerControls,
  type RpcLine,
} from "../helpers/fakeAppServer";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

import { codex } from "../../core/ai/codex.adapter";
import { CHAT_INSTRUCTIONS } from "../../core/ai/chatAdapter";
import type { ChatRunOptions } from "../../core/ai/chatAdapter";

/** A model in Codex's catalog, as `model/list` describes it. */
const codexModel = (id: string, extra: Record<string, unknown> = {}) => ({
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
  defaultReasoningEffort: "medium",
  ...extra,
});

/** What a turn does once it's started, given what it can send and await. */
type TurnScript = (turn: {
  emit: AppServerControls["emit"];
  /** Resolves with the app's answer to a request the server sent. */
  answerTo: (id: number) => Promise<RpcLine>;
  /** Ends the turn with this status. */
  complete: (status?: string, error?: string) => void;
}) => void | Promise<void>;

/**
 * A Codex app server: logged in, with `models`, that answers a turn with
 * `script`. Every run it serves is recorded in `runs`.
 */
function codexServer({
  models = [codexModel("gpt-6", { isDefault: true })],
  account = { type: "chatgpt" } as unknown,
  mcpServers = {} as Record<string, unknown>,
  script = (({ emit, complete }) => {
    emit(delta("Hello"));
    complete();
  }) as TurnScript,
} = {}) {
  const waiting = new Map<number, (line: RpcLine) => void>();
  const server = fakeAppServer((message, controls) => {
    if (message.method === undefined && typeof message.id === "number") {
      waiting.get(message.id)?.(message);
      return;
    }
    const reply = (result: unknown) =>
      controls.emit({ id: message.id, result });
    switch (message.method) {
      case "initialize":
        return reply({});
      case "initialized":
        return;
      case "account/read":
        return reply({ account, requiresOpenaiAuth: true });
      case "model/list":
        return reply({ data: models, nextCursor: null });
      case "config/read":
        return reply({ config: { mcp_servers: mcpServers } });
      case "thread/start":
        return reply({ thread: { id: "t1" } });
      case "turn/start":
        reply({ turn: { id: "u1" } });
        void script({
          emit: controls.emit,
          answerTo: (id) => new Promise((resolve) => waiting.set(id, resolve)),
          complete: (status = "completed", error) =>
            controls.emit({
              method: "turn/completed",
              params: {
                threadId: "t1",
                turn: { status, error: error ? { message: error } : null },
              },
            }),
        });
        return;
    }
  });
  mockSpawn.mockImplementation(server.spawn);
  return server;
}

const delta = (text: string, itemId = "m1"): RpcLine => ({
  method: "item/agentMessage/delta",
  params: { threadId: "t1", turnId: "u1", itemId, delta: text },
});

/** What the app sent to `method` in the run that chatted. */
function sentTo(
  server: ReturnType<typeof codexServer>,
  method: string,
  run = 0,
) {
  return server.runs[run]?.received.find((line) => line.method === method)
    ?.params;
}

function options(extra: Partial<ChatRunOptions> = {}): ChatRunOptions {
  return {
    abortSignal: new AbortController().signal,
    onText: () => {},
    effort: undefined,
    webSearch: false,
    onSource: () => {},
    askPermission: undefined,
    permissionMode: undefined,
    carried: [],
    ...extra,
  };
}

const HI = [{ role: "user" as const, content: "Hi" }];

beforeEach(() => {
  mockSpawn.mockReset();
});

describe("codex.connect", () => {
  it("lists the catalog's models apart from Claude Code's, with the default for small jobs", async () => {
    codexServer({
      models: [
        codexModel("gpt-6-mini"),
        codexModel("gpt-6", {
          isDefault: true,
          supportedReasoningEfforts: [
            { reasoningEffort: "minimal" },
            { reasoningEffort: "high" },
            { reasoningEffort: "someday" },
          ],
        }),
        codexModel("internal", { hidden: true }),
      ],
    });

    const catalog = await codex.connect();

    expect(catalog.models.map(({ id }) => id)).toEqual([
      "codex/gpt-6-mini",
      "codex/gpt-6",
    ]);
    expect(catalog.models[1]).toMatchObject({
      name: "GPT-6",
      acceptsImages: true,
      pricing: null,
      // Only the efforts the app's picker knows.
      reasoning: { efforts: ["minimal", "high"], defaultEffort: "medium" },
    });
    expect(catalog.helper).toEqual({ model: "codex/gpt-6", effort: "minimal" });
    expect(mockSpawn.mock.calls[0]?.[0]).toBe("codex");
    expect(mockSpawn.mock.calls[0]?.[1]).toEqual(["app-server"]);
  });

  it("fails when Codex isn't logged in", async () => {
    codexServer({ account: null });

    await expect(codex.connect()).rejects.toThrow(
      "Codex isn't logged in; run `codex login`",
    );
  });
});

describe("codex.chat", () => {
  it("streams the answer, on the person's own Codex setup", async () => {
    const server = codexServer({
      script: ({ emit, complete }) => {
        emit(delta("Hel"));
        emit(delta("lo"));
        complete();
      },
    });
    const pieces: string[] = [];

    await expect(
      codex.chat(
        "codex/gpt-6",
        HI,
        options({ onText: (t) => void pieces.push(t) }),
      ),
    ).resolves.toBe("Hello");

    expect(pieces).toEqual(["Hel", "lo"]);
    const thread = sentTo(server, "thread/start");
    expect(thread).toEqual({
      model: "gpt-6",
      cwd: homedir(),
      developerInstructions: CHAT_INSTRUCTIONS,
      config: { web_search: "disabled" },
    });
    // Nothing that decides what it may do: that's their own config's.
    expect(thread).not.toHaveProperty("sandbox");
    expect(thread).not.toHaveProperty("approvalPolicy");
    expect(thread).not.toHaveProperty("baseInstructions");
    expect(server.runs[0]?.options.cwd).toBe(homedir());
  });

  it("hands over the conversation as one message, with the chosen effort", async () => {
    const server = codexServer();

    await codex.chat(
      "codex/gpt-6",
      [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        {
          role: "user",
          content: [
            { type: "text", text: "Look" },
            { type: "image", mimeType: "image/png", data: "AAAA" },
          ],
        },
      ],
      options({ effort: "high", webSearch: true }),
    );

    expect(sentTo(server, "turn/start")).toEqual({
      threadId: "t1",
      input: [
        {
          type: "text",
          text: "<user>\nHi\n</user>\n\n<assistant>\nHello\n</assistant>\n\n<user>\nLook",
          text_elements: [],
        },
        { type: "image", url: "data:image/png;base64,AAAA" },
        { type: "text", text: "\n</user>", text_elements: [] },
      ],
      effort: "high",
    });
    expect(sentTo(server, "thread/start")?.config).toEqual({
      web_search: "live",
    });
  });

  it("starts a second message in the turn on a new paragraph", async () => {
    codexServer({
      script: ({ emit, complete }) => {
        emit(delta("Checking.", "m1"));
        emit(delta("Done.", "m2"));
        complete();
      },
    });

    await expect(codex.chat("codex/gpt-6", HI, options())).resolves.toBe(
      "Checking.\n\nDone.",
    );
  });

  it.each([
    ["acceptEdits", { sandbox: "workspace-write" }],
    [
      "bypassPermissions",
      { sandbox: "danger-full-access", approvalPolicy: "never" },
    ],
  ] as const)("runs in what %s means to Codex", async (mode, expected) => {
    const server = codexServer();

    await codex.chat("codex/gpt-6", HI, options({ permissionMode: mode }));

    expect(sentTo(server, "thread/start")).toMatchObject(expected);
  });

  it("carries on allowing edits once the person said so in the chat", async () => {
    const server = codexServer();

    await codex.chat(
      "codex/gpt-6",
      HI,
      options({ carried: [{ type: "mode", mode: "acceptEdits" }] }),
    );

    expect(sentTo(server, "thread/start")).toMatchObject({
      sandbox: "workspace-write",
    });
  });

  it("fails with what Codex said went wrong", async () => {
    codexServer({
      script: ({ emit, complete }) => {
        emit({
          method: "error",
          params: {
            error: { message: "Usage limit reached" },
            willRetry: false,
          },
        });
        complete("failed");
      },
    });

    await expect(codex.chat("codex/gpt-6", HI, options())).rejects.toThrow(
      "Usage limit reached",
    );
  });

  it("lists the pages a web search found or read", async () => {
    codexServer({
      script: ({ emit, complete }) => {
        emit({
          method: "item/completed",
          params: {
            item: {
              type: "webSearch",
              id: "w1",
              query: "news",
              action: { type: "openPage", url: "https://b.example" },
              results: [{ url: "https://a.example", title: "A" }],
            },
          },
        });
        emit(delta("Here."));
        complete();
      },
    });
    const onSource = vi.fn();

    await codex.chat("codex/gpt-6", HI, options({ webSearch: true, onSource }));

    expect(onSource.mock.calls).toEqual([
      ["https://a.example", "A"],
      ["https://b.example", undefined],
    ]);
  });
});

describe("codex.chat's approvals", () => {
  const commandRequest = (extra: Record<string, unknown> = {}): RpcLine => ({
    id: 100,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "t1",
      turnId: "u1",
      itemId: "c1",
      command: "mkdir a",
      cwd: "/home/me",
      ...extra,
    },
  });

  /** A turn that asks `request`, and what the app answered it. */
  function askingTurn(request: RpcLine) {
    let answered: RpcLine | undefined;
    const server = codexServer({
      script: async ({ emit, answerTo, complete }) => {
        emit(request);
        answered = await answerTo(request.id as number);
        complete();
      },
    });
    return { server, answered: () => answered };
  }

  it.each([
    ["allow", { decision: "accept" }],
    ["always", { decision: "acceptForSession" }],
    ["deny", { decision: "decline" }],
  ] as const)(
    "asks the person about a command, and answers %s",
    async (decision, expected) => {
      const turn = askingTurn(commandRequest());
      const askPermission = vi
        .fn()
        .mockResolvedValue(
          decision === "deny" ? { decision, message: "No" } : { decision },
        );

      await codex.chat("codex/gpt-6", HI, options({ askPermission }));

      expect(askPermission).toHaveBeenCalledWith(
        {
          program: "Codex",
          toolName: "Command",
          detail: "mkdir a",
          always: { label: "Allow in this chat", rules: [], mode: null },
          carry: [{ type: "command", command: "mkdir a" }],
        },
        expect.any(AbortSignal),
      );
      expect(turn.answered()?.result).toEqual(expected);
    },
  );

  it("saves Codex's own rule when it proposes one", async () => {
    const turn = askingTurn(
      commandRequest({ proposedExecpolicyAmendment: ["mkdir"] }),
    );
    const askPermission = vi.fn().mockResolvedValue({ decision: "always" });

    await codex.chat("codex/gpt-6", HI, options({ askPermission }));

    expect(askPermission.mock.calls[0]?.[0]).toMatchObject({
      always: { label: "Always allow", rules: ["mkdir"], mode: null },
      carry: [],
    });
    expect(turn.answered()?.result).toEqual({
      decision: {
        acceptWithExecpolicyAmendment: { execpolicy_amendment: ["mkdir"] },
      },
    });
  });

  it("doesn't ask again about a command allowed earlier in the chat", async () => {
    const turn = askingTurn(commandRequest());
    const askPermission = vi.fn();

    await codex.chat(
      "codex/gpt-6",
      HI,
      options({
        askPermission,
        carried: [{ type: "command", command: "mkdir a" }],
      }),
    );

    expect(askPermission).not.toHaveBeenCalled();
    expect(turn.answered()?.result).toEqual({ decision: "accept" });
  });

  it("shows a file change as its diff, and offers allowing all edits", async () => {
    let answered: RpcLine | undefined;
    codexServer({
      script: async ({ emit, answerTo, complete }) => {
        emit({
          method: "item/started",
          params: {
            item: {
              type: "fileChange",
              id: "f1",
              changes: [{ path: "/a.txt", kind: { type: "add" }, diff: "+hi" }],
            },
          },
        });
        emit({
          id: 101,
          method: "item/fileChange/requestApproval",
          params: { threadId: "t1", turnId: "u1", itemId: "f1" },
        });
        answered = await answerTo(101);
        complete();
      },
    });
    const askPermission = vi.fn().mockResolvedValue({ decision: "always" });

    await codex.chat("codex/gpt-6", HI, options({ askPermission }));

    expect(askPermission.mock.calls[0]?.[0]).toEqual({
      program: "Codex",
      toolName: "Edit",
      detail: "/a.txt\n+hi",
      always: { label: "Allow all edits", rules: [], mode: "acceptEdits" },
      carry: [{ type: "mode", mode: "acceptEdits" }],
    });
    expect(answered?.result).toEqual({ decision: "acceptForSession" });
  });

  it("declines what nobody can answer", async () => {
    const turn = askingTurn(commandRequest());

    await codex.chat("codex/gpt-6", HI, options());

    expect(turn.answered()?.result).toEqual({ decision: "decline" });
  });

  it("turns Codex's question tool into a question in the reply", async () => {
    const turn = askingTurn({
      id: 102,
      method: "item/tool/requestUserInput",
      params: { questions: [] },
    });
    const askPermission = vi.fn();

    await codex.chat("codex/gpt-6", HI, options({ askPermission }));

    expect(askPermission).not.toHaveBeenCalled();
    expect(turn.answered()?.error?.message).toContain("Ask in your reply");
  });

  it("stops asking once Codex stops waiting", async () => {
    let signal: AbortSignal | undefined;
    codexServer({
      script: async ({ emit, complete }) => {
        emit(commandRequest());
        await vi.waitFor(() => expect(signal).toBeDefined());
        emit({
          method: "serverRequest/resolved",
          params: { threadId: "t1", requestId: 100 },
        });
        await vi.waitFor(() => expect(signal?.aborted).toBe(true));
        complete();
      },
    });

    await codex.chat(
      "codex/gpt-6",
      HI,
      options({
        askPermission: (_request, abortSignal) => {
          signal = abortSignal;
          return new Promise(() => {});
        },
      }),
    );

    expect(signal?.aborted).toBe(true);
  });
});

describe("codex.helper", () => {
  it("runs Codex as a plain model, with every MCP server of theirs off", async () => {
    const server = codexServer({
      mcpServers: { github: {}, linear: {} },
      script: ({ emit, complete }) => {
        emit(delta("Planning"));
        complete();
      },
    });

    await expect(
      codex.helper("codex/gpt-6", "You write titles.", "Title this", {
        abortSignal: new AbortController().signal,
        effort: "minimal",
      }),
    ).resolves.toBe("Planning");

    // Its first run reads their config; the second answers.
    const thread = sentTo(server, "thread/start", 1);
    expect(thread).toMatchObject({
      model: "gpt-6",
      cwd: tmpdir(),
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      baseInstructions: "You write titles.",
    });
    expect((thread?.config as Record<string, unknown>).mcp_servers).toEqual({
      github: { enabled: false },
      linear: { enabled: false },
    });
    expect(
      (
        (thread?.config as Record<string, unknown>).features as Record<
          string,
          unknown
        >
      ).shell_tool,
    ).toBe(false);
    expect(sentTo(server, "turn/start", 1)?.effort).toBe("minimal");
  });
});
