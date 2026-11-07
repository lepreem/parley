import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/db", async () =>
  (await import("../helpers/inMemoryDb")).inMemoryDbModule(),
);

import { createApp } from "../../api/app";
import { memory } from "../../api/src/memory";

const CONVERSATION = randomUUID();
const app = await createApp();

/** Runs to close once a test is over, refusing anything they left waiting. */
const opened: { close: () => void }[] = [];
afterEach(() => {
  for (const run of opened.splice(0)) run.close();
});

/** A reply's run asking about one command. */
function askBash(command: string) {
  const run = memory.toolApprovals.open(CONVERSATION);
  opened.push(run);
  return run.ask(
    {
      program: "Claude Code",
      toolName: "Bash",
      detail: command,
      always: null,
      carry: [],
    },
    new AbortController().signal,
  );
}

const approvalsPath = `/conversations/${CONVERSATION}/tool-approvals`;

function answer(id: string, choice: unknown) {
  return app.request(`http://localhost${approvalsPath}/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer: choice }),
  });
}

function firstWaiting() {
  const [approval] = memory.toolApprovals.pending(CONVERSATION);
  if (!approval) throw new Error("Nothing is waiting");
  return approval;
}

describe("tool approvals over HTTP", () => {
  it("lists what a conversation's reply is waiting on, and takes the answer", async () => {
    const asked = askBash("mkdir a");
    const approval = firstWaiting();

    const listed = await app.request(`http://localhost${approvalsPath}`);
    expect(await listed.json()).toEqual([approval]);

    expect((await answer(approval.id, "allow")).status).toBe(204);
    await expect(asked).resolves.toEqual({ decision: "allow" });
  });

  it("passes a refusal back", async () => {
    const asked = askBash("mkdir b");

    await answer(firstWaiting().id, "deny");

    await expect(asked).resolves.toMatchObject({ decision: "deny" });
  });

  it("is a 404 for something no longer waiting", async () => {
    expect((await answer(randomUUID(), "allow")).status).toBe(404);
  });

  it("wants one of the answers it knows", async () => {
    expect((await answer(randomUUID(), "yes")).status).toBe(400);
  });

  it("can't be answered by another site open in the browser", async () => {
    const asked = askBash("mkdir c");
    const approval = firstWaiting();

    // A form post is the kind that needs no preflight.
    const forged = await app.request(
      `http://localhost${approvalsPath}/${approval.id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({ answer: "allowAll" }),
      },
    );
    expect(forged.status).toBe(403);
    expect(memory.toolApprovals.pending(CONVERSATION)).toHaveLength(1);

    await answer(approval.id, "deny");
    await asked;
  });
});
