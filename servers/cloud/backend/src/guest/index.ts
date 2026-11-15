/**
 * Everything only guests have: `guest.<what>`. A guest is a user like any
 * other, on the "guest" tier, except for their session: this server makes
 * their id and signs their token, the session can't be refreshed, signing in
 * moves what they made to the account, and they're deleted once it has
 * ended. Outside this folder a guest is just their tier.
 */

import { getEnv } from "../env";
import * as data from "../data";
import { logger } from "@parley/server-kit/runtime/logger";
import * as token from "./token";

const log = logger.child({ component: "guest" });

export { SESSION_SECONDS, isToken } from "./token";

/** Whether guests can chat: both guest settings are there (env.ts). */
export function enabled(): boolean {
  return getEnv().OPENROUTER_GUEST_API_KEY !== undefined;
}

/**
 * Who a guest's session token is for, and when it expires. Throws for a token
 * that isn't a valid guest's, and for any while guest chat is off.
 */
export async function verify(sessionToken: string) {
  if (!enabled()) throw new Error("Guest chat isn't enabled");
  return token.verifyToken(sessionToken);
}

/** A new guest: their user row, and the session token that names them. */
export async function start() {
  const userId = token.newUserId();
  await data.users.ensureUser(userId);
  return { userId, ...(await token.sign(userId)) };
}

/**
 * A guest signing in keeps what they made: the session cookie they arrive
 * with still names the guest, so their chats move to the account. Failing to
 * move them doesn't fail the sign-in, which has already spent WorkOS's code;
 * the guest is left as it was, for deleteExpired.
 */
export async function moveToAccount(
  sessionToken: string | undefined,
  userId: string,
) {
  if (!sessionToken || !token.isToken(sessionToken)) return;

  let guestUserId: string;
  try {
    ({ userId: guestUserId } = await verify(sessionToken));
  } catch {
    return;
  }

  try {
    await data.users.adoptGuest(guestUserId, userId);
  } catch (error) {
    log.error("Failed to move a guest's chats to their account", error, {
      guestUserId,
      userId,
    });
  }
}

/**
 * A day past the longest a guest session lasts, so a guest still signed in
 * is never deleted, whatever the clocks.
 */
const LIFETIME_MS = (token.SESSION_SECONDS + 24 * 60 * 60) * 1000;

/**
 * Deletes guests whose sessions have all ended, and what they made, and
 * returns how many. No one can open what they left. They own nothing in
 * storage (guests chat in text only), so there's nothing to remove there
 * first.
 */
export async function deleteExpired(): Promise<number> {
  return data.users.deleteGuestsCreatedBefore(
    new Date(Date.now() - LIFETIME_MS),
    { idPrefix: token.ID_PREFIX },
  );
}
