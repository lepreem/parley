import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFindUserConversations,
  mockRenameConversation,
  mockMoveConversation,
  mockFindUserProjects,
  mockCreateProject,
} = vi.hoisted(() => ({
  mockFindUserConversations: vi.fn(),
  mockRenameConversation: vi.fn(),
  mockMoveConversation: vi.fn(),
  mockFindUserProjects: vi.fn(),
  mockCreateProject: vi.fn(),
}));

vi.mock("../../src/db", async () => ({
  db: {},
  ...(await import("../helpers/dbTableStubs")).tableStubs,
}));

vi.mock("../../src/data/conversations.data", async (importActual) => ({
  ...(await importActual<typeof import("../../src/data/conversations.data")>()),
  findUserConversations: mockFindUserConversations,
  renameConversation: mockRenameConversation,
  moveConversation: mockMoveConversation,
}));

vi.mock("../../src/data/projects.data", async (importActual) => ({
  ...(await importActual<typeof import("../../src/data/projects.data")>()),
  findUserProjects: mockFindUserProjects,
  createProject: mockCreateProject,
}));

import { createApp } from "../../src/app";
import * as agentTools from "../../src/agentTools";
import { resetRateLimits } from "../../src/memory/rateLimitCounts";

const userId = "user_01OWNER";
const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const projectId = "550e8400-e29b-41d4-a716-446655440001";
const at = new Date("2026-11-20T00:00:00.000Z");
const conversationRow = {
  id: conversationId,
  title: "Trips",
  createdAt: at,
  updatedAt: at,
  lastMessageId: null,
  activeTurnClaimToken: null,
  projectId: null,
};

const onCall = vi.fn();

/** The tools of a turn answered for `tier`, on a freshly built app. */
async function toolsFor(tier: "free" | "guest") {
  await createApp();
  return agentTools.forTurn({
    user: { userId, tier },
    conversationId,
    onCall,
  });
}

const parsed = (output: string) =>
  JSON.parse(output) as { status: number; body: Record<string, unknown> };

describe("agent tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
  });

  it("describes each marked route by what its validators take", async () => {
    const { definitions, instructions } = await toolsFor("free");

    expect(instructions).toContain(conversationId);

    expect(definitions.map((definition) => definition.name).sort()).toEqual([
      "create_project",
      "list_chats",
      "list_projects",
      "move_chat_to_project",
      "rename_chat",
    ]);
    const rename = definitions.find((d) => d.name === "rename_chat");
    expect(rename?.parameters).toMatchObject({
      type: "object",
      properties: {
        conversationId: { type: "string", format: "uuid" },
        conversationTitle: { type: "string", minLength: 1 },
      },
      required: ["conversationId", "conversationTitle"],
    });
  });

  it("doesn't offer a guest the project tools", async () => {
    const { definitions, run } = await toolsFor("guest");

    expect(definitions.map((definition) => definition.name).sort()).toEqual([
      "list_chats",
      "rename_chat",
    ]);
    // Named anyway, it's no tool of theirs.
    const output = parsed(await run("create_project", '{"name":"Course"}'));
    expect(output.status).toBe(404);
    expect(mockCreateProject).not.toHaveBeenCalled();
    expect(onCall).not.toHaveBeenCalled();
  });

  it("runs a call through the route, as the user whose turn it is", async () => {
    mockRenameConversation.mockResolvedValue({
      ...conversationRow,
      title: "Holidays",
    });
    const { run } = await toolsFor("free");

    const output = parsed(
      await run(
        "rename_chat",
        JSON.stringify({ conversationId, conversationTitle: " Holidays " }),
      ),
    );

    expect(output).toMatchObject({
      status: 200,
      body: { id: conversationId, title: "Holidays" },
    });
    expect(onCall).toHaveBeenCalledWith("rename_chat");
    // Trimmed by the route's own schema, as a request from the browser is.
    expect(mockRenameConversation).toHaveBeenCalledWith(
      userId,
      conversationId,
      "Holidays",
    );
  });

  it("acts for the turn's user, whatever user the model names", async () => {
    mockFindUserConversations.mockResolvedValue([conversationRow]);
    const { run } = await toolsFor("free");

    await run("list_chats", JSON.stringify({ userId: "user_01SOMEONE_ELSE" }));

    expect(mockFindUserConversations).toHaveBeenCalledWith(userId);
  });

  it("hands the model the route's refusal, to read and act on", async () => {
    mockMoveConversation.mockResolvedValue(undefined);
    const { run } = await toolsFor("free");

    const notFound = parsed(
      await run(
        "move_chat_to_project",
        JSON.stringify({ conversationId, projectId }),
      ),
    );
    const invalid = parsed(
      await run(
        "rename_chat",
        JSON.stringify({ conversationId, conversationTitle: "" }),
      ),
    );

    expect(notFound).toEqual({
      status: 404,
      body: { message: "Conversation not found" },
    });
    expect(invalid).toEqual({
      status: 400,
      body: { message: "Title must not be empty" },
    });
  });

  it("answers a call it can't make without reaching the route", async () => {
    const { run } = await toolsFor("free");

    expect(parsed(await run("rename_chat", "{not json")).status).toBe(400);
    expect(
      parsed(await run("rename_chat", '{"conversationTitle":"x"}')).body,
    ).toEqual({ message: "conversationId is required" });
    expect(mockRenameConversation).not.toHaveBeenCalled();
  });

  it("leaves a request from outside to sign in, whatever it sends", async () => {
    const app = await createApp();

    const response = await app.request(
      "http://localhost/conversations",
      { headers: { "x-agent-call-user": userId } },
      // What @hono/node-server hands the app for a request off the network.
      { incoming: {}, outgoing: {}, agentCallUser: { userId, tier: "free" } },
    );

    expect(response.status).toBe(401);
    expect(mockFindUserConversations).not.toHaveBeenCalled();
  });
});
