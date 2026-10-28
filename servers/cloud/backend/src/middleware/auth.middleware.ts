import { createFactory, createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";

import { COOKIE_KEYS } from "../cookies/session";
import { logger } from "@parley/server-kit/runtime/logger";
import { verifyAccessToken } from "../auth/accessToken";

/** What requireAuth puts on the context of every route behind it. */
export type AuthEnv = {
  Variables: {
    userId: string;
    sessionExpiresAtEpochSeconds: number;
  };
};

export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const token = getCookie(c, COOKIE_KEYS.session);
  if (!token) return c.json({ message: "Unauthorized" }, 401);

  // Only the verification is the session's fault; whatever the route throws
  // after it is the route's, and must not come back as a 401.
  let session: Awaited<ReturnType<typeof verifyAccessToken>>;
  try {
    session = await verifyAccessToken(token);
  } catch (error) {
    logger.debug("Session token verification failed", { error: String(error) });
    return c.json({ message: "Unauthorized" }, 401);
  }

  c.set("userId", session.userId);
  c.set("sessionExpiresAtEpochSeconds", session.expiresAtEpochSeconds);
  await next();
});

/**
 * Builds the handlers of a route behind requireAuth: `c.var.userId` is typed,
 * and validators listed ahead of the handler type `c.req.valid(...)`.
 * `authed.createHandlers(validate("json", schema), async (c) => …)`
 */
export const authed = createFactory<AuthEnv>();
