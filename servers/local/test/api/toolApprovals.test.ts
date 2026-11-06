import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/db", async () =>
  (await import("../helpers/inMemoryDb")).inMemoryDbModule(),
);

import { createApp } from "../../api/app";
import { memory } from "../../api/src/memory";
import { TOOL_APPROVAL_SERVER_PATH } from "../../api/src/memory/toolApprovals";

const CONVERSATION = randomUUID();
const app = await createApp();

/** Runs to close once a test is over, refusing anything they left waiting. */
const opened: { close: () => void }[] = [];
function openRun() {
  const run = memory.toolApprovals.open(CONVERSATION);
  opened.push(run);
  return run;
}

afterEach(() => {
  for (const run of opened.splice(0)) run.close();
});

/** One JSON-RPC request, as Claude Code's MCP client sends it. */
function mcp(token: string | null, body: unknown) {
  return app.request(`http://127.0.0.1${TOOL_APPROVAL_SERVER_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

const askBash = (token: string, command: string) =>
  mcp(token, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "ask",
      arguments: { tool_name: "Bash", input: { command }, tool_use_id: "t1" },
    },
  });

/** What a prompt's call resolved to. */
async function answerOf(res: Response) {
  const body = (await res.json()) as {
    result: { content: { text: string }[] };
  };
  return JSON.parse(body.result.content[0]?.text ?? "") as unknown;
}

const approvalsPath = `/conversations/${CONVERSATION}/tool-approvals`;

function answer(id: string, allow: unknown) {
  return app.request(`http://localhost${approvalsPath}/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ allow }),
  });
}

async function firstWaiting() {
  await vi.waitFor(() =>
    expect(memory.toolApprovals.pending(CONVERSATION)).toHaveLength(1),
  );
  return memory.toolApprovals.pending(CONVERSATION)[0]!;
}

describe("the server Claude Code asks", () => {
  it("refuses a request from anything but an open run", async () => {
    expect((await mcp(null, { id: 1, method: "tools/list" })).status).toBe(401);
    expect((await mcp("guess", { id: 1, method: "tools/list" })).status).toBe(
      401,
    );
  });

  it("introduces itself and its one tool", async () => {
    const { token } = openRun();

    const init = await mcp(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    });
    expect(await init.json()).toMatchObject({
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
      },
    });

    const list = await mcp(token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(await list.json()).toMatchObject({
      result: { tools: [{ name: "ask" }] },
    });
  });

  it("takes notifications without an answer, and says what it doesn't know", async () => {
    const { token } = openRun();

    const note = await mcp(token, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(note.status).toBe(202);

    const unknown = await mcp(token, {
      jsonrpc: "2.0",
      id: 3,
      method: "server/discover",
    });
    expect(await unknown.json()).toMatchObject({
      id: 3,
      error: { code: -32601 },
    });
  });

  it("holds a tool call until the person answers", async () => {
    const { token } = openRun();
    const call = askBash(token, "mkdir a");

    const approval = await firstWaiting();
    expect(approval).toMatchObject({ toolName: "Bash", detail: "mkdir a" });

    const listed = await app.request(`http://localhost${approvalsPath}`);
    expect(await listed.json()).toEqual([approval]);

    expect((await answer(approval.id, true)).status).toBe(204);
    expect(await answerOf(await call)).toEqual({
      behavior: "allow",
      updatedInput: { command: "mkdir a" },
    });
  });

  it("passes a refusal back", async () => {
    const { token } = openRun();
    const call = askBash(token, "mkdir b");

    await answer((await firstWaiting()).id, false);

    expect(await answerOf(await call)).toMatchObject({ behavior: "deny" });
  });

  it("rejects a malformed tool call", async () => {
    const { token } = openRun();
    const res = await mcp(token, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "ask", arguments: { input: "nope" } },
    });
    expect(await res.json()).toMatchObject({ error: { code: -32602 } });
  });
});

describe("POST /conversations/:id/tool-approvals/:id", () => {
  it("is a 404 for something no longer waiting", async () => {
    expect((await answer(randomUUID(), true)).status).toBe(404);
  });

  it("wants a real answer", async () => {
    expect((await answer(randomUUID(), "yes")).status).toBe(400);
  });

  it("can't be answered by another site open in the browser", async () => {
    const { token } = openRun();
    const call = askBash(token, "mkdir c");
    const approval = await firstWaiting();

    // A form post is the kind that needs no preflight.
    const forged = await app.request(
      `http://localhost${approvalsPath}/${approval.id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({ allow: true }),
      },
    );
    expect(forged.status).toBe(403);
    expect(memory.toolApprovals.pending(CONVERSATION)).toHaveLength(1);

    await answer(approval.id, false);
    await call;
  });
});
