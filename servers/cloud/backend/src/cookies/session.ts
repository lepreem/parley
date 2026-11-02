import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { getEnv } from "../env";

export const COOKIE_KEYS = {
  session: "session",
  refresh: "refresh",
} as const;

/**
 * The API serves the client in production, so the cookie only ever travels
 * to its own site and `Lax` is enough. A browser won't send it with another
 * site's POST at all, which a third-party (`None`) cookie needed `csrf()` in
 * app.ts to make up for. Safari refuses third-party cookies outright.
 *
 * `Secure` in production only: locally the client and the API share
 * `localhost` over plain HTTP, where it would stop the cookie being stored.
 */
function sessionCookieOptions(path: string) {
  return {
    httpOnly: true,
    secure: getEnv().NODE_ENV === "production",
    sameSite: "Lax" as const,
    path,
  };
}

/**
 * Where the browser sends each cookie. The refresh token is only ever read
 * by the endpoint that spends it, so it goes there and nowhere else.
 */
const AUTH_COOKIES = {
  session: { name: COOKIE_KEYS.session, path: "/" },
  refresh: { name: COOKIE_KEYS.refresh, path: "/auth/refresh" },
};

export function setAuthCookies(
  c: Context,
  tokens: { accessToken: string; refreshToken: string },
): void {
  const { session, refresh } = AUTH_COOKIES;
  setCookie(
    c,
    session.name,
    tokens.accessToken,
    sessionCookieOptions(session.path),
  );
  setCookie(
    c,
    refresh.name,
    tokens.refreshToken,
    sessionCookieOptions(refresh.path),
  );
}

/**
 * A guest has no refresh token, only the session cookie. It's kept for as
 * long as the session lasts, closed browser or not: losing it loses the
 * guest's chats.
 */
export function setGuestCookie(
  c: Context,
  token: string,
  maxAgeSeconds: number,
): void {
  const { session } = AUTH_COOKIES;
  setCookie(c, session.name, token, {
    ...sessionCookieOptions(session.path),
    maxAge: maxAgeSeconds,
  });
}

/**
 * The attributes have to match the ones the cookie was set with, or the
 * browser treats this as a different cookie and keeps the original.
 */
export function clearAuthCookies(c: Context): void {
  for (const { name, path } of Object.values(AUTH_COOKIES)) {
    deleteCookie(c, name, sessionCookieOptions(path));
  }
}
