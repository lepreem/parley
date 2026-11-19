import { and, eq, like, lt, sql } from "drizzle-orm";
import type { Avatar } from "@parley/contract/avatars";
import { Conversations, db, users as Users } from "../db";

/**
 * First login creates the row; every later one is a no-op. The auth provider
 * owns identity, so there is nothing to update here.
 */
export async function ensureUser(userId: string) {
  await db.insert(Users).values({ id: userId }).onConflictDoNothing();
}

/**
 * The picture they picked, or null when they haven't picked one (or have no
 * row). The users_avatar_whole check keeps the two columns set together.
 */
export async function findAvatar(userId: string): Promise<Avatar | null> {
  const [row] = await db
    .select({ glyph: Users.avatarGlyph, color: Users.avatarColor })
    .from(Users)
    .where(eq(Users.id, userId))
    .limit(1);
  if (!row?.glyph || !row.color) return null;
  return { glyph: row.glyph, color: row.color };
}

/**
 * Saves the picture they picked. A guest's row, or a user whose row was
 * lost, gets one made, as ensureUser would have.
 */
export async function setAvatar(userId: string, avatar: Avatar) {
  await db
    .insert(Users)
    .values({
      id: userId,
      avatarGlyph: avatar.glyph,
      avatarColor: avatar.color,
    })
    .onConflictDoUpdate({
      target: Users.id,
      set: { avatarGlyph: avatar.glyph, avatarColor: avatar.color },
    });
}

/**
 * Gives everything a guest made to a user, and deletes the guest, in one
 * transaction. The user's row has to exist already; when it was made, at this
 * sign-in or a year ago, makes no difference. The guest's conversations keep
 * their place in the list: moving them isn't an edit.
 *
 * Only conversations move, because they're all a guest can have:
 * guests chat in text only (requireFeature("attachments") on the upload routes). Letting them
 * upload would need more than adding Attachments here. Each stored object's key
 * starts with its owner's id (objectPath in storage/core.ts), so the objects
 * would have to move in storage too, and their storage_ledger rows with them;
 * deleting the guest as this does now would cascade their attachment rows
 * away and unlink them from the moved messages.
 *
 * Messages go with their conversation: they have no owner of their own.
 */
export async function adoptGuest(guestUserId: string, userId: string) {
  await db.transaction(async (tx) => {
    await tx
      .update(Conversations)
      .set({ userId, updatedAt: sql`${Conversations.updatedAt}` })
      .where(eq(Conversations.userId, guestUserId));
    await tx.delete(Users).where(eq(Users.id, guestUserId));
  });
}

/**
 * Deletes guests, the users whose ids start with `idPrefix`, made before
 * `createdBefore`, with everything they made, and returns how many.
 */
export async function deleteGuestsCreatedBefore(
  createdBefore: Date,
  { idPrefix }: { idPrefix: string },
) {
  const deleted = await db
    .delete(Users)
    .where(
      and(
        like(Users.id, `${escapeLike(idPrefix)}%`),
        lt(Users.createdAt, createdBefore),
      ),
    )
    .returning({ id: Users.id });
  return deleted.length;
}

/** `text` as a LIKE pattern matches it, with its wildcards escaped. */
function escapeLike(text: string) {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}
