import { MAX_PROJECTS } from "@parley/contract/limits";
import { and, count, desc, eq, type SQL } from "drizzle-orm";
import { Conversations, db, Projects, users as Users } from "../db";

const projectColumns = {
  id: Projects.id,
  name: Projects.name,
  instructions: Projects.instructions,
  createdAt: Projects.createdAt,
  updatedAt: Projects.updatedAt,
};

export type ProjectRow = Pick<
  typeof Projects.$inferSelect,
  keyof typeof projectColumns
>;

/** Every write and single-row read is gated on ownership, never id alone. */
export function ownedBy(userId: string, projectId: string): SQL | undefined {
  return and(eq(Projects.id, projectId), eq(Projects.userId, userId));
}

/** Most recently made first. */
export async function findUserProjects(userId: string) {
  return db
    .select(projectColumns)
    .from(Projects)
    .where(eq(Projects.userId, userId))
    .orderBy(desc(Projects.createdAt), desc(Projects.id));
}

/**
 * Null when the user already has MAX_PROJECTS. Their user row is locked while
 * it counts, so two creates at once can't both slip under the limit.
 */
export async function createProject(
  userId: string,
  project: { name: string; instructions?: string | undefined },
) {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: Users.id })
      .from(Users)
      .where(eq(Users.id, userId))
      .for("update");
    const [owned] = await tx
      .select({ count: count() })
      .from(Projects)
      .where(eq(Projects.userId, userId));
    if ((owned?.count ?? 0) >= MAX_PROJECTS) return null;

    const [row] = await tx
      .insert(Projects)
      .values({
        userId,
        name: project.name,
        ...(project.instructions !== undefined
          ? { instructions: project.instructions }
          : {}),
      })
      .returning(projectColumns);
    return row ?? null;
  });
}

/** Null when the user doesn't own it, which the caller reports as a 404. */
export async function updateProject(
  userId: string,
  projectId: string,
  changes: { name?: string | undefined; instructions?: string | undefined },
) {
  const [row] = await db
    .update(Projects)
    .set({
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.instructions !== undefined
        ? { instructions: changes.instructions }
        : {}),
      updatedAt: new Date(),
    })
    .where(ownedBy(userId, projectId))
    .returning(projectColumns);

  return row ?? null;
}

/**
 * Deletes the project for good. Its chats stay, in no project: the
 * conversations' foreign key sets their project_id to null.
 */
export async function deleteOwnedProject(userId: string, projectId: string) {
  const [row] = await db
    .delete(Projects)
    .where(ownedBy(userId, projectId))
    .returning({ id: Projects.id });

  return row ?? null;
}

/**
 * What a turn in this conversation is answered with: its project's
 * instructions, or "" for a chat in no project.
 */
export async function findConversationInstructions(
  userId: string,
  conversationId: string,
): Promise<string> {
  const [row] = await db
    .select({ instructions: Projects.instructions })
    .from(Conversations)
    .innerJoin(Projects, eq(Projects.id, Conversations.projectId))
    .where(
      and(
        eq(Conversations.id, conversationId),
        eq(Conversations.userId, userId),
      ),
    )
    .limit(1);

  return row?.instructions ?? "";
}
