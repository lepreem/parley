import {
  MAX_PROJECT_INSTRUCTIONS_LENGTH,
  MAX_PROJECTS,
} from "@parley/contract/limits";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFindUserProjects,
  mockCreateProject,
  mockUpdateProject,
  mockDeleteOwnedProject,
  mockCreateConversation,
  mockMoveConversation,
} = vi.hoisted(() => ({
  mockFindUserProjects: vi.fn(),
  mockCreateProject: vi.fn(),
  mockUpdateProject: vi.fn(),
  mockDeleteOwnedProject: vi.fn(),
  mockCreateConversation: vi.fn(),
  mockMoveConversation: vi.fn(),
}));

vi.mock("../../src/db", async () => ({
  db: {},
  ...(await import("../helpers/dbTableStubs")).tableStubs,
}));

vi.mock("../../src/data/projects.data", async (importActual) => ({
  ...(await importActual<typeof import("../../src/data/projects.data")>()),
  findUserProjects: mockFindUserProjects,
  createProject: mockCreateProject,
  updateProject: mockUpdateProject,
  deleteOwnedProject: mockDeleteOwnedProject,
}));

vi.mock("../../src/data/conversations.data", async (importActual) => ({
  ...(await importActual<typeof import("../../src/data/conversations.data")>()),
  createConversation: mockCreateConversation,
  moveConversation: mockMoveConversation,
}));

import { createApp } from "../../src/app";
import { resetRateLimits } from "../../src/memory/rateLimitCounts";
import { authedHeaders, guestCookieHeader } from "../helpers/session";

const userId = "user_01OWNER";
const projectId = "550e8400-e29b-41d4-a716-446655440001";
const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const at = "2026-11-19T00:00:00.000Z";
const projectRow = {
  id: projectId,
  name: "Course",
  instructions: "Answer in French.",
  createdAt: new Date(at),
  updatedAt: new Date(at),
};
const projectJson = { ...projectRow, createdAt: at, updatedAt: at };
const conversationRow = {
  id: conversationId,
  title: "New conversation",
  createdAt: new Date(at),
  updatedAt: new Date(at),
  lastMessageId: null,
  activeTurnClaimToken: null,
  projectId,
};

async function request(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  return (await createApp()).request(`http://localhost${path}`, {
    method,
    headers: {
      ...(headers ?? (await authedHeaders(userId))),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function guestHeaders() {
  return {
    Origin: process.env.CLIENT_URL!,
    Cookie: await guestCookieHeader(
      "guest_00000000-0000-4000-8000-000000000002",
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
});

describe("/projects", () => {
  it("lists the user's projects", async () => {
    mockFindUserProjects.mockResolvedValueOnce([projectRow]);

    const res = await request("GET", "/projects");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projects: [projectJson] });
    expect(mockFindUserProjects).toHaveBeenCalledWith(userId);
  });

  it("is closed to guests", async () => {
    const res = await request("GET", "/projects", undefined, {
      ...(await guestHeaders()),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "Sign in to use projects" });
    expect(mockFindUserProjects).not.toHaveBeenCalled();
  });

  it("makes a project, its name trimmed", async () => {
    mockCreateProject.mockResolvedValueOnce(projectRow);

    const res = await request("POST", "/projects", {
      name: "  Course ",
      instructions: "Answer in French.",
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(projectJson);
    expect(mockCreateProject).toHaveBeenCalledWith(userId, {
      name: "Course",
      instructions: "Answer in French.",
    });
  });

  it("says so at the limit", async () => {
    mockCreateProject.mockResolvedValueOnce(null);

    const res = await request("POST", "/projects", { name: "One more" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      message: `You can have ${MAX_PROJECTS} projects. Delete one to make another.`,
    });
  });

  it("turns away a blank name and instructions over the limit", async () => {
    const blank = await request("POST", "/projects", { name: "   " });
    const long = await request("POST", "/projects", {
      name: "Course",
      instructions: "x".repeat(MAX_PROJECT_INSTRUCTIONS_LENGTH + 1),
    });

    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual({ message: "Name must not be empty" });
    expect(long.status).toBe(400);
    expect(await long.json()).toEqual({
      message: "Instructions are too long",
    });
    expect(mockCreateProject).not.toHaveBeenCalled();
  });

  it("changes a project, and needs something to change", async () => {
    mockUpdateProject.mockResolvedValueOnce({
      ...projectRow,
      instructions: "",
    });

    const changed = await request("PATCH", `/projects/${projectId}`, {
      instructions: "",
    });
    const empty = await request("PATCH", `/projects/${projectId}`, {});

    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ ...projectJson, instructions: "" });
    expect(mockUpdateProject).toHaveBeenCalledWith(userId, projectId, {
      instructions: "",
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ message: "Nothing to change" });
  });

  it("answers 404 for a project that isn't the user's", async () => {
    mockUpdateProject.mockResolvedValueOnce(null);
    mockDeleteOwnedProject.mockResolvedValueOnce(null);

    const update = await request("PATCH", `/projects/${projectId}`, {
      name: "Mine",
    });
    const remove = await request("DELETE", `/projects/${projectId}`);

    expect(update.status).toBe(404);
    expect(remove.status).toBe(404);
  });

  it("deletes a project", async () => {
    mockDeleteOwnedProject.mockResolvedValueOnce({ id: projectId });

    const res = await request("DELETE", `/projects/${projectId}`);

    expect(res.status).toBe(200);
    expect(mockDeleteOwnedProject).toHaveBeenCalledWith(userId, projectId);
  });
});

describe("chats in projects", () => {
  it("starts a chat in a project", async () => {
    mockCreateConversation.mockResolvedValueOnce(conversationRow);

    const res = await request("POST", "/conversations", { projectId });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: conversationId, projectId });
    expect(mockCreateConversation).toHaveBeenCalledWith(userId, { projectId });
  });

  it("answers 404 for a project that isn't the user's", async () => {
    mockCreateConversation.mockResolvedValueOnce(null);

    const res = await request("POST", "/conversations", { projectId });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "Project not found" });
  });

  it("won't let a guest start a chat in a project", async () => {
    const res = await request(
      "POST",
      "/conversations",
      { projectId },
      await guestHeaders(),
    );

    expect(res.status).toBe(403);
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  it("moves a chat into a project and out again", async () => {
    mockMoveConversation
      .mockResolvedValueOnce(conversationRow)
      .mockResolvedValueOnce({ ...conversationRow, projectId: null });

    const into = await request(
      "PUT",
      `/conversations/${conversationId}/project`,
      {
        projectId,
      },
    );
    const out = await request(
      "PUT",
      `/conversations/${conversationId}/project`,
      {
        projectId: null,
      },
    );

    expect(into.status).toBe(200);
    expect(await into.json()).toMatchObject({ projectId });
    expect(out.status).toBe(200);
    expect(await out.json()).toMatchObject({ projectId: null });
    expect(mockMoveConversation).toHaveBeenNthCalledWith(
      1,
      userId,
      conversationId,
      projectId,
    );
    expect(mockMoveConversation).toHaveBeenNthCalledWith(
      2,
      userId,
      conversationId,
      null,
    );
  });

  it("answers 404 when the chat or the project isn't the user's", async () => {
    mockMoveConversation.mockResolvedValueOnce(null);

    const res = await request(
      "PUT",
      `/conversations/${conversationId}/project`,
      { projectId },
    );

    expect(res.status).toBe(404);
  });

  it("won't let a guest move a chat", async () => {
    const res = await request(
      "PUT",
      `/conversations/${conversationId}/project`,
      { projectId: null },
      await guestHeaders(),
    );

    expect(res.status).toBe(403);
    expect(mockMoveConversation).not.toHaveBeenCalled();
  });
});
