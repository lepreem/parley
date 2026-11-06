import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock("../../api/src/sse/hub", () => ({
  EVERYONE: "everyone",
  eventHub: { send: mockSend },
}));

import { toolApprovals } from "../../api/src/memory/toolApprovals";

const CONVERSATION = "conversation-1";
const OTHER_CONVERSATION = "conversation-2";

/** Claude Code's "don't ask again" for a Bash command, as it sends it. */
const RULE_SUGGESTION = {
  type: "addRules",
  rules: [{ toolName: "Bash", ruleContent: "mkdir a *" }],
  behavior: "allow",
  destination: "localSettings",
};

const bash = (command: string, suggestions: unknown[] = []) => ({
  toolName: "Bash",
  input: { command },
  suggestions,
});

describe("tool approvals", () => {
  beforeEach(() => {
    mockSend.mockClear();
  });

  /** Opens a run and asks about one command. */
  function askCommand(command = "mkdir a", suggestions: unknown[] = []) {
    const run = toolApprovals.open(CONVERSATION);
    const answer = run.ask(
      bash(command, suggestions),
      new AbortController().signal,
    );
    const approval = toolApprovals.pending(CONVERSATION).at(-1);
    if (!approval) throw new Error("Nothing is waiting");
    return { run, answer, approval };
  }

  it("shows a command as itself and tells the page", () => {
    const { run, approval } = askCommand("rm -rf build");

    expect(approval).toMatchObject({
      toolName: "Bash",
      detail: "rm -rf build",
      always: null,
    });
    expect(mockSend).toHaveBeenCalledWith("everyone", "toolApprovalsChanged", {
      conversationId: CONVERSATION,
      approvals: [approval],
    });
    run.close();
  });

  it("shows another tool's whole input", () => {
    const run = toolApprovals.open(CONVERSATION);
    void run.ask(
      {
        toolName: "Write",
        input: { file_path: "/a", content: "secret plan" },
        suggestions: [],
      },
      new AbortController().signal,
    );

    expect(toolApprovals.pending(CONVERSATION)[0]?.detail).toContain(
      "secret plan",
    );
    run.close();
  });

  it("allows once with the input unchanged, as Claude Code requires", async () => {
    const { run, answer, approval } = askCommand();

    expect(toolApprovals.answer(CONVERSATION, approval.id, "allow")).toBe(true);

    await expect(answer).resolves.toEqual({
      behavior: "allow",
      updatedInput: { command: "mkdir a" },
    });
    expect(toolApprovals.pending(CONVERSATION)).toEqual([]);
    run.close();
  });

  it("offers Claude Code's own don't-ask-again, and passes it back as it came", async () => {
    const { run, answer, approval } = askCommand("mkdir a", [RULE_SUGGESTION]);

    expect(approval.always).toEqual({
      label: "Always allow",
      rules: ["Bash(mkdir a *)"],
      mode: null,
    });
    toolApprovals.answer(CONVERSATION, approval.id, "always");

    await expect(answer).resolves.toEqual({
      behavior: "allow",
      updatedInput: { command: "mkdir a" },
      updatedPermissions: [RULE_SUGGESTION],
    });
    run.close();
  });

  it("offers allowing all edits when that's what Claude Code suggests", () => {
    const { run, approval } = askCommand("x", [
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ]);

    expect(approval.always).toEqual({
      label: "Allow all edits",
      rules: [],
      mode: "acceptEdits",
    });
    run.close();
  });

  it("lists only what's saved when Claude Code suggests more for this reply", () => {
    const { run, approval } = askCommand("touch /elsewhere/f1", [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "touch /elsewhere/f1" }],
        behavior: "allow",
        destination: "localSettings",
      },
      {
        type: "addDirectories",
        directories: ["/elsewhere"],
        destination: "session",
      },
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ]);

    expect(approval.always).toEqual({
      label: "Always allow",
      rules: ["Bash(touch /elsewhere/f1)"],
      mode: null,
    });
    run.close();
  });

  it("keeps what lasts for the session for the rest of the conversation", async () => {
    const { run, answer, approval } = askCommand("touch /elsewhere/f1", [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "touch /elsewhere/f1" }],
        behavior: "allow",
        destination: "localSettings",
      },
      {
        type: "addDirectories",
        directories: ["/elsewhere"],
        destination: "session",
      },
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ]);
    expect(toolApprovals.sessionGrants(OTHER_CONVERSATION)).toBeUndefined();

    toolApprovals.answer(CONVERSATION, approval.id, "always");
    await answer;

    // The rule itself is Claude Code's to save, in their settings file.
    expect(toolApprovals.sessionGrants(CONVERSATION)).toEqual({
      allow: [],
      directories: ["/elsewhere"],
      mode: "acceptEdits",
    });
    expect(toolApprovals.sessionGrants(OTHER_CONVERSATION)).toBeUndefined();
    run.close();
  });

  it("denies when the person says no", async () => {
    const { run, answer, approval } = askCommand();

    toolApprovals.answer(CONVERSATION, approval.id, "deny");

    await expect(answer).resolves.toMatchObject({ behavior: "deny" });
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
    const first = run.ask(bash("mkdir a"), new AbortController().signal);
    const second = run.ask(bash("mkdir b"), new AbortController().signal);
    const [approval] = toolApprovals.pending(CONVERSATION);

    toolApprovals.answer(CONVERSATION, approval?.id ?? "", "allowAll");

    await expect(first).resolves.toMatchObject({ behavior: "allow" });
    // One already waiting, and one asked afterwards, go ahead without asking.
    await expect(second).resolves.toMatchObject({ behavior: "allow" });
    await expect(
      run.ask(bash("mkdir c"), new AbortController().signal),
    ).resolves.toMatchObject({ behavior: "allow" });
    expect(toolApprovals.pending(CONVERSATION)).toEqual([]);
    run.close();
  });

  it("asks again in the next reply after allow all", async () => {
    const { run, approval } = askCommand();
    toolApprovals.answer(CONVERSATION, approval.id, "allowAll");
    run.close();

    const next = toolApprovals.open(CONVERSATION);
    void next.ask(bash("mkdir d"), new AbortController().signal);

    expect(toolApprovals.pending(CONVERSATION)).toHaveLength(1);
    next.close();
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
  });

  it("takes the card away when Claude Code stops waiting", async () => {
    const run = toolApprovals.open(CONVERSATION);
    const controller = new AbortController();
    const answer = run.ask(bash("mkdir e"), controller.signal);

    controller.abort();

    await expect(answer).resolves.toMatchObject({ behavior: "deny" });
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

  it("turns Claude Code's question tool into a question in the reply", async () => {
    const run = toolApprovals.open(CONVERSATION);

    await expect(
      run.ask(
        {
          toolName: "AskUserQuestion",
          input: { questions: [] },
          suggestions: [],
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("Ask in your reply"),
    });
    expect(toolApprovals.pending(CONVERSATION)).toEqual([]);
    run.close();
  });
});
