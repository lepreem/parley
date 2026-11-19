import { eq, sql } from "drizzle-orm";
import type { Sql } from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { exportSchemaSql } from "../helpers/schemaSql";

const testState = vi.hoisted(() => ({
  databaseUrl: process.env.ATTACHMENT_TEST_DATABASE_URL,
  schemaName: `projects_test_${Date.now()}`,
  client: null as Sql | null,
}));

vi.mock("../../src/db", async () => {
  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const schema = await import("../../src/db/schema");
  const client = postgres(
    testState.databaseUrl ?? "postgres://localhost/unused",
    {
      max: 5,
      connection: { search_path: testState.schemaName },
      onnotice: () => {},
    },
  );
  testState.client = client;
  return { ...schema, db: drizzle(client, { schema }) };
});

import { Conversations, db, Projects, users } from "../../src/db";
import * as conversationsData from "../../src/data/conversations.data";
import * as projectsData from "../../src/data/projects.data";
import { MAX_PROJECTS } from "@parley/contract/limits";

const userId = "projects-owner";
const otherUserId = "projects-stranger";

// ATTACHMENT_TEST_DATABASE_URL enables these tests; each run creates and drops its own schema.
describe.skipIf(!testState.databaseUrl)("projects, in PostgreSQL", () => {
  beforeAll(async () => {
    await db.execute(sql.raw(`create schema "${testState.schemaName}"`));
    const schemaSql = exportSchemaSql().replaceAll(
      '"public"',
      `"${testState.schemaName}"`,
    );
    await testState.client!.unsafe(schemaSql);
  });

  afterAll(async () => {
    await db.execute(sql.raw(`drop schema "${testState.schemaName}" cascade`));
    await testState.client!.end();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate ${users} cascade`);
    await db.insert(users).values([{ id: userId }, { id: otherUserId }]);
  });

  it("stops at the limit, even when the creates come at once", async () => {
    const made = await Promise.all(
      Array.from({ length: MAX_PROJECTS + 3 }, (_, i) =>
        projectsData.createProject(userId, { name: `Project ${i}` }),
      ),
    );

    expect(made.filter((row) => row !== null)).toHaveLength(MAX_PROJECTS);
    expect(made.filter((row) => row === null)).toHaveLength(3);
    // Another user's limit is their own.
    expect(
      await projectsData.createProject(otherUserId, { name: "Theirs" }),
    ).not.toBeNull();
  });

  it("starts a chat in a project, and answers it with the instructions", async () => {
    const project = await projectsData.createProject(userId, {
      name: "Course",
      instructions: "Answer in French.",
    });
    const chat = await conversationsData.createConversation(userId, {
      projectId: project!.id,
    });

    expect(chat?.projectId).toBe(project!.id);
    expect(
      await projectsData.findConversationInstructions(userId, chat!.id),
    ).toBe("Answer in French.");
  });

  it("answers a chat in no project with no instructions", async () => {
    const chat = await conversationsData.createConversation(userId);

    expect(chat?.projectId).toBeNull();
    expect(
      await projectsData.findConversationInstructions(userId, chat!.id),
    ).toBe("");
  });

  it("won't start or move a chat into someone else's project", async () => {
    const theirs = await projectsData.createProject(otherUserId, {
      name: "Theirs",
    });
    const chat = await conversationsData.createConversation(userId);

    expect(
      await conversationsData.createConversation(userId, {
        projectId: theirs!.id,
      }),
    ).toBeNull();
    expect(
      await conversationsData.moveConversation(userId, chat!.id, theirs!.id),
    ).toBeNull();
    const [row] = await db
      .select({ projectId: Conversations.projectId })
      .from(Conversations)
      .where(eq(Conversations.id, chat!.id));
    expect(row?.projectId).toBeNull();
  });

  it("moves a chat in and out without moving it in the list", async () => {
    const project = await projectsData.createProject(userId, { name: "P" });
    const updatedAt = new Date("2026-01-02T03:04:05Z");
    const [chat] = await db
      .insert(Conversations)
      .values({ userId, updatedAt })
      .returning();

    const moved = await conversationsData.moveConversation(
      userId,
      chat!.id,
      project!.id,
    );
    expect(moved).toMatchObject({ projectId: project!.id, updatedAt });

    const out = await conversationsData.moveConversation(
      userId,
      chat!.id,
      null,
    );
    expect(out).toMatchObject({ projectId: null, updatedAt });
  });

  it("won't let a stranger move, change or delete a chat or project", async () => {
    const project = await projectsData.createProject(userId, { name: "P" });
    const chat = await conversationsData.createConversation(userId);

    expect(
      await conversationsData.moveConversation(otherUserId, chat!.id, null),
    ).toBeNull();
    expect(
      await projectsData.updateProject(otherUserId, project!.id, {
        name: "Mine now",
      }),
    ).toBeNull();
    expect(
      await projectsData.deleteOwnedProject(otherUserId, project!.id),
    ).toBeNull();
    expect(
      await projectsData.findConversationInstructions(otherUserId, chat!.id),
    ).toBe("");
  });

  it("keeps a deleted project's chats, in no project", async () => {
    const project = await projectsData.createProject(userId, {
      name: "P",
      instructions: "Be brief.",
    });
    const chat = await conversationsData.createConversation(userId, {
      projectId: project!.id,
    });

    expect(
      await projectsData.deleteOwnedProject(userId, project!.id),
    ).not.toBeNull();

    const [row] = await db
      .select({ projectId: Conversations.projectId })
      .from(Conversations)
      .where(eq(Conversations.id, chat!.id));
    expect(row?.projectId).toBeNull();
    expect(
      await projectsData.findConversationInstructions(userId, chat!.id),
    ).toBe("");
    expect(await db.select().from(Projects)).toEqual([]);
  });

  it("changes only what it's given", async () => {
    const project = await projectsData.createProject(userId, {
      name: "P",
      instructions: "Be brief.",
    });

    expect(
      await projectsData.updateProject(userId, project!.id, { name: "Q" }),
    ).toMatchObject({ name: "Q", instructions: "Be brief." });
    expect(
      await projectsData.updateProject(userId, project!.id, {
        instructions: "",
      }),
    ).toMatchObject({ name: "Q", instructions: "" });
  });
});
