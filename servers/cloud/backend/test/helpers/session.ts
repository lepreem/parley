import { COOKIE_KEYS } from "../../src/cookies/session";
import { signGuestToken } from "../../src/auth/guestToken";
import { signAccessToken } from "./accessTokens";

/** A session cookie for a guest, signed as the server signs one. */
export async function guestCookieHeader(guestUserId: string): Promise<string> {
  const { token } = await signGuestToken(guestUserId);
  return `${COOKIE_KEYS.session}=${token}`;
}

export async function sessionCookieHeader(
  userId: string,
  sessionId = "session_01TEST",
): Promise<string> {
  const token = await signAccessToken({
    userId,
    sessionId,
    expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 3600,
  });
  return `${COOKIE_KEYS.session}=${token}`;
}

/**
 * Browsers always send Origin on unsafe methods, and csrf() in app.ts rejects
 * form-style requests that arrive without one. Tests have to model that, or
 * every POST and DELETE comes back 403 for reasons unrelated to what they
 * are asserting.
 */
export async function authedHeaders(
  userId: string,
  sessionId?: string,
): Promise<Record<string, string>> {
  return {
    Origin: process.env.CLIENT_URL!,
    Cookie: await sessionCookieHeader(userId, sessionId),
  };
}
