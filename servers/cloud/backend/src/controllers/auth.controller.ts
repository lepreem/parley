import type { Context } from "hono";
import { getCookie } from "hono/cookie";

import { getEnv } from "../env";
import { workos } from "../auth/auth";
import { readAccessTokenExpiry, verifyAccessToken } from "../auth/accessToken";
import { refreshSession } from "../auth/refreshSession";
import { clearAuthCookies, setAuthCookies } from "../cookies/session";
import { authed } from "../middleware/auth.middleware";

import { COOKIE_KEYS } from "../cookies/session";
import { data } from "../data";
import { logger } from "@parley/server-kit/runtime/logger";

const log = logger.child({ controller: "auth" });

export async function handleLogin(c: Context) {
  return c.redirect(workos.getRedirectUrl());
}

/** When an access token expires, as the auth responses report it. */
function expiresAt(epochSeconds: number) {
  return new Date(epochSeconds * 1000).toISOString();
}

/**
 * Who is signed in, and when their access token expires, so the client can
 * refresh it before then.
 */
export const handleMe = authed.createHandlers(async (c) => {
  return c.json({
    userId: c.var.userId,
    expiresAt: expiresAt(c.var.sessionExpiresAtEpochSeconds),
  });
});

/**
 * Whether WorkOS turned the refresh token down, as opposed to failing to
 * answer: it answers a spent, revoked or expired one with a 4xx.
 */
function isRejectedByWorkos(error: unknown) {
  const { status } = error as { status?: unknown };
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 429
  );
}

/**
 * Trades the refresh cookie for a new access token and refresh token, and
 * answers who the session is for and when the new access token expires, so
 * the client can refresh again before it does. A refresh token WorkOS turns
 * down means the session is over: both cookies are cleared and the answer
 * is a 401, which the client reads as signed out.
 *
 * WorkOS spends the old refresh token as it answers, so the new cookies are
 * set before anything else can fail: losing them would sign the user out.
 */
export async function handleRefresh(c: Context) {
  const refreshToken = getCookie(c, COOKIE_KEYS.refresh);
  if (!refreshToken) return c.json({ message: "Unauthorized" }, 401);

  let tokens: Awaited<ReturnType<typeof refreshSession>>;
  try {
    tokens = await refreshSession(refreshToken);
  } catch (error) {
    if (!isRejectedByWorkos(error)) throw error;
    log.debug("WorkOS refused a refresh token", { error: String(error) });
    clearAuthCookies(c);
    return c.json({ message: "Unauthorized" }, 401);
  }

  setAuthCookies(c, tokens);
  return c.json({
    userId: tokens.userId,
    expiresAt: expiresAt(readAccessTokenExpiry(tokens.accessToken)),
  });
}

export async function handleLogout(c: Context) {
  const token = getCookie(c, COOKIE_KEYS.session);
  clearAuthCookies(c);

  if (!token) return c.json(null, 200);

  // The token has usually expired by the time someone logs out; it's still
  // what names the session to end.
  let sessionId: string;
  try {
    ({ sessionId } = await verifyAccessToken(token, { allowExpired: true }));
  } catch {
    return c.json(null, 200);
  }

  try {
    await workos.revokeAuthSession(sessionId);
  } catch (error) {
    log.error("Failed to revoke WorkOS session", error);
  }

  return c.json(null, 200);
}

export async function handleCallback(c: Context) {
  const code = c.req.query("code");
  if (!code) return c.json({ message: "code required" }, 400);

  const { userId, accessToken, refreshToken } =
    await workos.getAuthSessionFromCode(code);

  await data.users.ensureUser(userId);
  setAuthCookies(c, { accessToken, refreshToken });

  return c.redirect(getEnv().CLIENT_URL);
}
