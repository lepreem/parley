import { createFactory, createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";

import { COOKIE_KEYS } from "../cookies/session";
import { logger } from "@parley/server-kit/runtime/logger";
import { verifyAccessToken } from "../auth/accessToken";
import { isGuestToken, verifyGuestToken } from "../auth/guestToken";
import { guestChatEnabled } from "../env";

/** What requireAuth puts on the context of every route behind it. */
export type AuthEnv = {
  Variables: {
    userId: string;
    sessionExpiresAtEpochSeconds: number;
    /** Signed in as a guest rather than through WorkOS. */
    isGuest: boolean;
  };
};

/**
 * Who a session token is for: a WorkOS user, or a guest while guest chat is
 * on. Throws for a token that's neither.
 */
export async function verifySessionToken(token: string) {
  if (isGuestToken(token)) {
    if (!guestChatEnabled()) throw new Error("Guest chat isn't enabled");
    return { ...(await verifyGuestToken(token)), isGuest: true };
  }
  return { ...(await verifyAccessToken(token)), isGuest: false };
}

export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const token = getCookie(c, COOKIE_KEYS.session);
  if (!token) return c.json({ message: "Unauthorized" }, 401);

  // Only the verification is the session's fault; whatever the route throws
  // after it is the route's, and must not come back as a 401.
  let session: Awaited<ReturnType<typeof verifySessionToken>>;
  try {
    session = await verifySessionToken(token);
  } catch (error) {
    logger.debug("Session token verification failed", { error: String(error) });
    return c.json({ message: "Unauthorized" }, 401);
  }

  c.set("userId", session.userId);
  c.set("sessionExpiresAtEpochSeconds", session.expiresAtEpochSeconds);
  c.set("isGuest", session.isGuest);
  await next();
});

/**
 * Turns guests away, behind requireAuth. Guests chat in text only: see
 * users.adoptGuest for what letting them upload would take.
 */
export const refuseGuests = createMiddleware<AuthEnv>(async (c, next) => {
  if (c.var.isGuest) return c.json({ message: "Sign in to add files" }, 403);
  await next();
});

/**
 * Builds the handlers of a route behind requireAuth: `c.var.userId` is typed,
 * and validators listed ahead of the handler type `c.req.valid(...)`.
 * `authed.createHandlers(validate("json", schema), async (c) => …)`
 */
export const authed = createFactory<AuthEnv>();
