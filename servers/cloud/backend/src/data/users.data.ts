import { and, eq, like, lt, sql } from "drizzle-orm";
import type {
  Avatar,
  AvatarColor,
  AvatarGlyph,
} from "@parley/contract/avatars";
import { Conversations, db, users as Users } from "../db";

/**
 * First login creates the row; every later one is a no-op. The auth provider
 * owns identity, so there is nothing to update here.
 */
export async function ensureUser(userId: string) {
  await db.insert(Users).values({ id: userId }).onConflictDoNothing();
}

/**
 * How they appear: the picture and username they picked, each null when they
 * haven't picked one (or have no row). The users_avatar_whole check keeps the
 * two avatar columns set together.
 */
export async function findProfile(userId: string) {
  const [row] = await db
    .select(profileColumns)
    .from(Users)
    .where(eq(Users.id, userId))
    .limit(1);
  return toProfile(row);
}

/**
 * Saves whichever of their picture and username is given, and returns the
 * profile as it now stands. A guest's row, or a user whose row was lost, gets
 * one made, as ensureUser would have.
 */
export async function updateProfile(
  userId: string,
  changes: { avatar?: Avatar; username?: string | null },
) {
  const set = {
    ...(changes.avatar && {
      avatarGlyph: changes.avatar.glyph,
      avatarColor: changes.avatar.color,
    }),
    ...(changes.username !== undefined && { username: changes.username }),
  };
  const [row] = await db
    .insert(Users)
    .values({ id: userId, ...set })
    .onConflictDoUpdate({ target: Users.id, set })
    .returning(profileColumns);
  return toProfile(row);
}

const profileColumns = {
  glyph: Users.avatarGlyph,
  color: Users.avatarColor,
  username: Users.username,
};

function toProfile(
  row:
    | {
        glyph: AvatarGlyph | null;
        color: AvatarColor | null;
        username: string | null;
      }
    | undefined,
): { avatar: Avatar | null; username: string | null } {
  return {
    avatar:
      row?.glyph && row.color ? { glyph: row.glyph, color: row.color } : null,
    username: row?.username ?? null,
  };
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
