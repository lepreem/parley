import { and, eq, like, lt, sql } from "drizzle-orm";
import { ChatMessages, Conversations, db, users as Users } from "../db";
import { GUEST_USER_ID_PATTERN } from "../auth/guestToken";

/**
 * First login creates the row; every later one is a no-op. The auth provider
 * owns identity, so there is nothing to update here.
 */
async function ensureUser(userId: string) {
  await db.insert(Users).values({ id: userId }).onConflictDoNothing();
}

/**
 * Gives everything a guest made to a user, and deletes the guest, in one
 * transaction. The user's row has to exist already; when it was made, at this
 * sign-in or a year ago, makes no difference. The guest's conversations keep
 * their place in the list: moving them isn't an edit.
 *
 * Only conversations and messages move, because they're all a guest can have:
 * guests chat in text only (refuseGuests on the upload routes). Letting them
 * upload would need more than adding Attachments here. Each stored object's key
 * starts with its owner's id (objectPath in storage/core.ts), so the objects
 * would have to move in storage too, and their storage_ledger rows with them;
 * deleting the guest as this does now would cascade their attachment rows
 * away and unlink them from the moved messages.
 *
 * chat_messages refuses updates (drizzle/0004_immutable_messages.sql), except
 * to the columns its trigger tolerates, which user_id is one of
 * (drizzle/0005_tolerate_owner_change.sql).
 */
async function adoptGuest(guestUserId: string, userId: string) {
  await db.transaction(async (tx) => {
    await tx
      .update(Conversations)
      .set({ userId, updatedAt: sql`${Conversations.updatedAt}` })
      .where(eq(Conversations.userId, guestUserId));
    // updated_at would change on its own (schema.ts's $onUpdate), and the
    // trigger tolerates only user_id.
    await tx
      .update(ChatMessages)
      .set({ userId, updatedAt: sql`${ChatMessages.updatedAt}` })
      .where(eq(ChatMessages.userId, guestUserId));
    await tx.delete(Users).where(eq(Users.id, guestUserId));
  });
}

/**
 * Deletes guests made before `createdBefore`, with everything they made, and
 * returns how many. Guest sessions don't outlast GUEST_SESSION_SECONDS, so
 * past that no one can open what these guests left.
 */
async function deleteGuestsCreatedBefore(createdBefore: Date) {
  const deleted = await db
    .delete(Users)
    .where(
      and(
        like(Users.id, GUEST_USER_ID_PATTERN),
        lt(Users.createdAt, createdBefore),
      ),
    )
    .returning({ id: Users.id });
  return deleted.length;
}

export const users = {
  ensureUser,
  adoptGuest,
  deleteGuestsCreatedBefore,
};
