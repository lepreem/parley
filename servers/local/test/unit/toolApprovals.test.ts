import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock("../../api/src/sse/hub", () => ({
  EVERYONE: "everyone",
  eventHub: { send: mockSend },
}));

import { toolApprovals } from "../../api/src/memory/toolApprovals";

const CONVERSATION = "conversation-1";
const OTHER_CONVERSATION = "conversation-2";
const WAIT_MS = 4 * 60 * 1000;

describe("tool approvals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSend.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Opens a run and asks about one command. */
  function askCommand(command = "mkdir a") {
    const run = toolApprovals.open(CONVERSATION);
    const answer = toolApprovals.ask(run.token, "Bash", { command });
    const [approval] = toolApprovals.pending(CONVERSATION);
    if (!approval) throw new Error("Nothing is waiting");
    return { run, answer, approval };
  }

  it("shows a command as itself and tells the page", () => {
    const { run, approval } = askCommand("rm -rf build");

    expect(approval.toolName).toBe("Bash");
    expect(approval.detail).toBe("rm -rf build");
    expect(mockSend).toHaveBeenCalledWith("everyone", "toolApprovalsChanged", {
      conversationId: CONVERSATION,
      approvals: [approval],
    });
    run.close();
  });

  it("shows another tool's whole input", () => {
    const run = toolApprovals.open(CONVERSATION);
    void toolApprovals.ask(run.token, "Write", {
      file_path: "/a",
      content: "secret plan",
    });

    expect(toolApprovals.pending(CONVERSATION)[0]?.detail).toContain(
      "secret plan",
    );
    run.close();
  });

  it("allows with the input unchanged, as Claude Code requires", async () => {
    const { run, answer, approval } = askCommand();

    expect(toolApprovals.answer(CONVERSATION, approval.id, true)).toBe(true);

    await expect(answer).resolves.toEqual({
      behavior: "allow",
      updatedInput: { command: "mkdir a" },
    });
    expect(toolApprovals.pending(CONVERSATION)).toEqual([]);
    run.close();
  });

  it("denies when the person says no", async () => {
    const { run, answer, approval } = askCommand();

    toolApprovals.answer(CONVERSATION, approval.id, false);

    await expect(answer).resolves.toMatchObject({ behavior: "deny" });
    run.close();
  });

  it("denies when nobody answers in time", async () => {
    const { run, answer } = askCommand();

    await vi.advanceTimersByTimeAsync(WAIT_MS);

    await expect(answer).resolves.toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("in time"),
    });
    expect(toolApprovals.pending(CONVERSATION)).toEqual([]);
    run.close();
  });

  it("gives Claude Code longer than the person gets", () => {
    const { run } = askCommand();
    expect(run.timeoutMs).toBeGreaterThan(WAIT_MS);
    run.close();
  });

  it("denies whatever's left when the run ends, and tells the page", async () => {
    const { run, answer } = askCommand();
    mockSend.mockClear();

    run.close();

    await expect(answer).resolves.toMatchObject({ behavior: "deny" });
    expect(mockSend).toHaveBeenCalledWith("everyone", "toolApprovalsChanged", {
      conversationId: CONVERSATION,
      approvals: [],
    });
    expect(toolApprovals.isOpen(run.token)).toBe(false);
  });

  it("won't take an answer through another conversation", async () => {
    const { run, answer, approval } = askCommand();

    expect(toolApprovals.answer(OTHER_CONVERSATION, approval.id, true)).toBe(
      false,
    );
    expect(toolApprovals.pending(CONVERSATION)).toHaveLength(1);

    run.close();
    await answer;
  });

  it("won't take a second answer", async () => {
    const { run, answer, approval } = askCommand();
    toolApprovals.answer(CONVERSATION, approval.id, false);
    await answer;

    expect(toolApprovals.answer(CONVERSATION, approval.id, true)).toBe(false);
    run.close();
  });

  it("denies a prompt from a run that's over without showing it", async () => {
    await expect(
      toolApprovals.ask("not-a-run", "Bash", { command: "mkdir a" }),
    ).resolves.toMatchObject({ behavior: "deny" });
    expect(toolApprovals.pending(CONVERSATION)).toEqual([]);
  });

  it("turns Claude Code's question tool into a question in the reply", async () => {
    const run = toolApprovals.open(CONVERSATION);

    await expect(
      toolApprovals.ask(run.token, "AskUserQuestion", { questions: [] }),
    ).resolves.toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("Ask in your reply"),
    });
    expect(toolApprovals.pending(CONVERSATION)).toEqual([]);
    run.close();
  });

  it("marks the run as alive when asking and when answered", async () => {
    const run = toolApprovals.open(CONVERSATION);
    const markProgress = vi.fn();
    run.onActivity(markProgress);

    const answer = toolApprovals.ask(run.token, "Bash", { command: "ls" });
    expect(markProgress).toHaveBeenCalledTimes(1);

    const [approval] = toolApprovals.pending(CONVERSATION);
    toolApprovals.answer(CONVERSATION, approval?.id ?? "", true);
    await answer;
    expect(markProgress).toHaveBeenCalledTimes(2);
    run.close();
  });
});
