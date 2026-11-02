import { randomUUID } from "node:crypto";
import { decodeJwt, jwtVerify, SignJWT } from "jose";
import { getEnv } from "../env";

/**
 * A guest is a user like any other, under an id this server makes rather than
 * one from WorkOS, in a session token it signs itself. Signing in moves what
 * the guest made to their account (users.adoptGuest) and the guest is gone.
 */
const GUEST_ID_PREFIX = "guest_";
const GUEST_ISSUER = "parley-guest";

/**
 * How long a guest session lasts, from when it began; nothing extends it.
 * The sweeper deletes guests older than this, whose chats no one can open.
 */
export const GUEST_SESSION_SECONDS = 30 * 24 * 60 * 60;

export function newGuestUserId(): string {
  return `${GUEST_ID_PREFIX}${randomUUID()}`;
}

/** Guest ids, as SQL LIKE matches them: the prefix with its `_` escaped. */
export const GUEST_USER_ID_PATTERN = `${GUEST_ID_PREFIX.replace("_", "\\_")}%`;

function secret() {
  const value = getEnv().GUEST_SESSION_SECRET;
  if (value === undefined) throw new Error("Guest chat isn't enabled");
  return new TextEncoder().encode(value);
}

export async function signGuestToken(userId: string) {
  const expiresAtEpochSeconds =
    Math.floor(Date.now() / 1000) + GUEST_SESSION_SECONDS;
  const token = await new SignJWT()
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(GUEST_ISSUER)
    .setSubject(userId)
    .setExpirationTime(expiresAtEpochSeconds)
    .sign(secret());
  return { token, expiresAtEpochSeconds };
}

/**
 * Whether a session token claims to be a guest's, read without verifying it:
 * only to pick which check to make. WorkOS signs its tokens with RS256 and
 * these are HS256, and each check accepts only its own algorithm, so a token
 * routed to the wrong one fails rather than passes.
 */
export function isGuestToken(token: string): boolean {
  try {
    return decodeJwt(token).iss === GUEST_ISSUER;
  } catch {
    return false;
  }
}

export async function verifyGuestToken(token: string) {
  const { payload } = await jwtVerify(token, secret(), {
    algorithms: ["HS256"],
    issuer: GUEST_ISSUER,
  });
  if (
    typeof payload.sub !== "string" ||
    !payload.sub.startsWith(GUEST_ID_PREFIX)
  ) {
    throw new Error("Guest token is missing a guest ID");
  }
  if (typeof payload.exp !== "number") {
    throw new Error("Guest token is missing an expiry");
  }
  return { userId: payload.sub, expiresAtEpochSeconds: payload.exp };
}
