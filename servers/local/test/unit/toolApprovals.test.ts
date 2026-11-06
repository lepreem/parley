import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PermissionRequest } from "../../core/ai/ai_chat_client";

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock("../../api/src/sse/hub", () => ({
  EVERYONE: "everyone",
  eventHub: { send: mockSend },
}));

import { toolApprovals } from "../../api/src/memory/toolApprovals";

const CONVERSATION = "conversation-1";
const OTHER_CONVERSATION = "conversation-2";

/** A request as an adapter hands it over, already in the card's terms. */
const command = (
  detail: string,
  extra: Partial<PermissionRequest> = {},
): PermissionRequest => ({
  program: "Claude Code",
  toolName: "Bash",
  detail,
  always: null,
  carry: [],
  ...extra,
});

describe("tool approvals", () => {
  beforeEach(() => {
    mockSend.mockClear();
  });

  /** Opens a run and asks about one command. */
  function askCommand(request = command("mkdir a")) {
    const run = toolApprovals.open(CONVERSATION);
    const answer = run.ask(request, new AbortController().signal);
    const approval = toolApprovals.pending(CONVERSATION).at(-1);
    if (!approval) throw new Error("Nothing is waiting");
    return { run, answer, approval };
  }

  it("shows the request as the adapter put it, and tells the page", () => {
    const always = { label: "Always allow", rules: ["Bash(rm *)"], mode: null };
    const { run, approval } = askCommand(command("rm -rf build", { always }));

    expect(approval).toMatchObject({
      program: "Claude Code",
      toolName: "Bash",
      detail: "rm -rf build",
      always,
    });
    expect(mockSend).toHaveBeenCalledWith("everyone", "toolApprovalsChanged", {
      conversationId: CONVERSATION,
      approvals: [approval],
    });
    run.close();
  });

  it("allows once", async () => {
    const { run, answer, approval } = askCommand();

    expect(toolApprovals.answer(CONVERSATION, approval.id, "allow")).toBe(true);

    await expect(answer).resolves.toEqual({ decision: "allow" });
    expect(toolApprovals.pending(CONVERSATION)).toEqual([]);
    run.close();
  });

  it("keeps what lasts for the session for the rest of the conversation", async () => {
    const carry = [{ any: "thing the adapter reads" }];
    const { run, answer, approval } = askCommand(command("x", { carry }));
    expect(toolApprovals.carried(OTHER_CONVERSATION)).toEqual([]);

    toolApprovals.answer(CONVERSATION, approval.id, "always");

    await expect(answer).resolves.toEqual({ decision: "always" });
    expect(toolApprovals.carried(CONVERSATION)).toEqual(carry);
    expect(toolApprovals.carried(OTHER_CONVERSATION)).toEqual([]);
    run.close();
  });

  it("keeps nothing for a plain allow", async () => {
    const { run, answer, approval } = askCommand(
      command("y", { carry: [{ not: "kept" }] }),
    );

    toolApprovals.answer(OTHER_CONVERSATION, approval.id, "allow");
    toolApprovals.answer(CONVERSATION, approval.id, "allow");
    await answer;

    expect(toolApprovals.carried(CONVERSATION)).not.toContainEqual({
      not: "kept",
    });
    run.close();
  });

  it("denies when the person says no", async () => {
    const { run, answer, approval } = askCommand();

    toolApprovals.answer(CONVERSATION, approval.id, "deny");

    await expect(answer).resolves.toMatchObject({ decision: "deny" });
    run.close();
  });

  it("waits for as long as it takes", async () => {
    vi.useFakeTimers();
    try {
      const { run, approval } = askCommand();

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

      expect(toolApprovals.pending(CONVERSATION)).toEqual([approval]);
      run.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows the rest of the reply once the person says allow all", async () => {
    const run = toolApprovals.open(CONVERSATION);
    const first = run.ask(command("mkdir a"), new AbortController().signal);
    const second = run.ask(command("mkdir b"), new AbortController().signal);
    const [approval] = toolApprovals.pending(CONVERSATION);

    toolApprovals.answer(CONVERSATION, approval?.id ?? "", "allowAll");

    await expect(first).resolves.toEqual({ decision: "allow" });
    // One already waiting, and one asked afterwards, go ahead without asking.
    await expect(second).resolves.toEqual({ decision: "allow" });
    await expect(
      run.ask(command("mkdir c"), new AbortController().signal),
    ).resolves.toEqual({ decision: "allow" });
    expect(toolApprovals.pending(CONVERSATION)).toEqual([]);
    run.close();
  });

  it("asks again in the next reply after allow all", async () => {
    const { run, approval } = askCommand();
    toolApprovals.answer(CONVERSATION, approval.id, "allowAll");
    run.close();

    const next = toolApprovals.open(CONVERSATION);
    void next.ask(command("mkdir d"), new AbortController().signal);

    expect(toolApprovals.pending(CONVERSATION)).toHaveLength(1);
    next.close();
  });

  it("denies whatever's left when the run ends, and tells the page", async () => {
    const { run, answer } = askCommand();
    mockSend.mockClear();

    run.close();

    await expect(answer).resolves.toMatchObject({ decision: "deny" });
    expect(mockSend).toHaveBeenCalledWith("everyone", "toolApprovalsChanged", {
      conversationId: CONVERSATION,
      approvals: [],
    });
  });

  it("takes the card away when the program stops waiting", async () => {
    const run = toolApprovals.open(CONVERSATION);
    const controller = new AbortController();
    const answer = run.ask(command("mkdir e"), controller.signal);

    controller.abort();

    await expect(answer).resolves.toMatchObject({ decision: "deny" });
    expect(toolApprovals.pending(CONVERSATION)).toEqual([]);
    run.close();
  });

  it("won't take an answer through another conversation", async () => {
    const { run, answer, approval } = askCommand();

    expect(toolApprovals.answer(OTHER_CONVERSATION, approval.id, "allow")).toBe(
      false,
    );
    expect(toolApprovals.pending(CONVERSATION)).toHaveLength(1);

    run.close();
    await answer;
  });

  it("won't take a second answer", async () => {
    const { run, answer, approval } = askCommand();
    toolApprovals.answer(CONVERSATION, approval.id, "deny");
    await answer;

    expect(toolApprovals.answer(CONVERSATION, approval.id, "allow")).toBe(
      false,
    );
    run.close();
  });
});
