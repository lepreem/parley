import { decodeJwt, jwtVerify } from "jose";
import { workosKeys } from "./workosKeys";

/**
 * How long past its expiry a token is still read when the caller allows it.
 * Only logout does, to learn which session to end; a token older than this
 * belongs to a session that has long ended anyway.
 */
const EXPIRED_TOLERANCE = "30d";

/** Who a verified access token says is calling. */
export type AccessTokenClaims = {
  userId: string;
  sessionId: string;
  expiresAtEpochSeconds: number;
};

/**
 * Verifies a WorkOS access token the way the WorkOS SDK does: its signature
 * against WorkOS's published keys, and its expiry. It depends on nothing else
 * in the app, so a load balancer or gateway can make the same check with
 * standard JWT validation against the same keys.
 */
export async function verify(
  token: string,
  { allowExpired = false }: { allowExpired?: boolean } = {},
): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(
    token,
    workosKeys(),
    allowExpired ? { clockTolerance: EXPIRED_TOLERANCE } : {},
  );

  if (typeof payload.sub !== "string") {
    throw new Error("Access token is missing a user ID");
  }
  if (typeof payload.sid !== "string") {
    throw new Error("Access token is missing a session ID");
  }
  if (typeof payload.exp !== "number") {
    throw new Error("Access token is missing an expiry");
  }

  return {
    userId: payload.sub,
    sessionId: payload.sid,
    expiresAtEpochSeconds: payload.exp,
  };
}

/**
 * An access token's expiry, read without verifying it. Only for a token this
 * server just got from WorkOS itself, where there's nothing to verify: a
 * check that fetched WorkOS's keys could fail after WorkOS had already spent
 * the refresh token that bought it.
 */
export function readExpiry(token: string): number {
  const { exp } = decodeJwt(token);
  if (typeof exp !== "number") {
    throw new Error("Access token is missing an expiry");
  }
  return exp;
}
