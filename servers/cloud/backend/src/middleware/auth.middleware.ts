import { createFactory, createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";

import { COOKIE_KEYS } from "../cookies/session";
import { logger } from "@parley/server-kit/runtime/logger";
import { verifyAccessToken } from "../auth/accessToken";
import { isGuestToken, verifyGuestToken } from "../auth/guestToken";
import { guestChatEnabled } from "../env";
import {
  CAPABILITIES,
  howToReach,
  type Feature,
  type Tier,
} from "@parley/contract/tiers";

/** What requireAuth puts on the context of every route behind it. */
export type AuthEnv = {
  Variables: {
    userId: string;
    sessionExpiresAtEpochSeconds: number;
    /** What the user can do: see @parley/contract/tiers. */
    tier: Tier;
  };
};

/**
 * Who a session token is for: a WorkOS user, or a guest while guest chat is
 * on. Throws for a token that's neither.
 */
export async function verifySessionToken(token: string) {
  if (isGuestToken(token)) {
    if (!guestChatEnabled()) throw new Error("Guest chat isn't enabled");
    return { ...(await verifyGuestToken(token)), tier: "guest" as const };
  }
  // Every WorkOS user is on one tier until there are plans to pay for.
  return { ...(await verifyAccessToken(token)), tier: "signedIn" as const };
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
  c.set("tier", session.tier);
  await next();
});

/** What a refused request is told, given how to get the feature. */
const REFUSALS: Record<Feature, (howToReach: string) => string> = {
  attachments: (how) => `${capitalized(how)} to add files`,
  dictation: (how) => `${capitalized(how)} to dictate`,
  chooseEffort: (how) => `Invalid effort: ${how} to choose one`,
  webSearch: (how) => `Web search: ${how} to use it`,
};

function capitalized(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Why this tier can't use the feature, telling them how to get it. */
export function refusalOf(tier: Tier, feature: Feature): string {
  return REFUSALS[feature](howToReach(tier, feature) ?? "upgrade");
}

/**
 * Turns away, behind requireAuth, anyone whose tier lacks the feature. Guests
 * can't attach: see users.adoptGuest for what letting them upload would take.
 */
export function requireFeature(feature: Feature) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    if (!CAPABILITIES[c.var.tier][feature])
      return c.json({ message: refusalOf(c.var.tier, feature) }, 403);
    await next();
  });
}

/**
 * Builds the handlers of a route behind requireAuth: `c.var.userId` is typed,
 * and validators listed ahead of the handler type `c.req.valid(...)`.
 * `authed.createHandlers(validate("json", schema), async (c) => …)`
 */
export const authed = createFactory<AuthEnv>();
