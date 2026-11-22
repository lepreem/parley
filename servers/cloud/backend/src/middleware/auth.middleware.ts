import { createFactory, createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";

import { COOKIE_KEYS } from "../cookies/session";
import { logger } from "@parley/server-kit/runtime/logger";
import * as auth from "../auth";
import * as guest from "../guest";
import * as agentTools from "../agentTools";
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
  if (guest.isToken(token)) {
    return { ...(await guest.verify(token)), tier: "guest" as const };
  }
  // Every WorkOS user is on the free tier until there are plans to pay for.
  return { ...(await auth.verify(token)), tier: "free" as const };
}

export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  // A tool call from the model, made inside this process during a chat turn,
  // for the user whose turn it is. That turn's request was signed in, which is
  // the check this call relies on. No request from outside can be one of
  // these: see agentTools/agentCallUser.ts.
  const agentCallUser = agentTools.readAgentCallUser(c.env);
  if (agentCallUser) {
    c.set("userId", agentCallUser.userId);
    c.set("tier", agentCallUser.tier);
    // Only GET /auth/me reads this, and it isn't a tool. The turn checked a
    // session that hadn't expired; this call has no session of its own.
    c.set("sessionExpiresAtEpochSeconds", Math.floor(Date.now() / 1000));
    await next();
    return;
  }

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
  projects: (how) => `${capitalized(how)} to use projects`,
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
