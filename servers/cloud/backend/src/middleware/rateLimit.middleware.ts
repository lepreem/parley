import { isIP } from "node:net";
import type { Context } from "hono";
import { MemoryStore, rateLimiter } from "hono-rate-limiter";
import { getConnInfo } from "@hono/node-server/conninfo";
import {
  RATE_LIMIT_POLICIES,
  type RateLimitKey,
  type RateLimitName,
} from "../rateLimit/policies";
import type { AuthEnv } from "./auth.middleware";
import { getEnv } from "../env";

const rateLimitMessage = {
  message: "Too many requests, please try again later.",
};

/**
 * The client's IP, as the server's Caddy proxy reports it in X-Real-IP
 * (servers/cloud/deploy/parley.caddy). Caddy sets the header to the address
 * that connected to it, replacing whatever the client sent, and in
 * production the API publishes no port of its own, so every request comes
 * through Caddy. The socket's peer is Caddy for every request, so keying on
 * it would put every user in one bucket.
 *
 * A value that isn't a single IP (a duplicated header arrives joined with
 * ", ") isn't trusted. Without Caddy in front, as in local development, the
 * socket address is the client.
 */
function getClientIpKey(c: Context): string {
  const realIp = c.req.header("x-real-ip")?.trim();
  if (realIp && isIP(realIp)) return realIp;

  // TODO: log warning that we're not using x-real-ip.
  try {
    const address = getConnInfo(c).remote.address;
    if (address) return address;
  } catch {
    // Tests / non-Node adapters may not have socket info
  }
  return "unknown";
}
function getUserId(
  c: Context<{ Variables: Partial<AuthEnv["Variables"]> }>,
): string {
  const userId = c.get("userId");
  if (typeof userId !== "string" || userId.length === 0)
    throw new Error(
      "Rate limiter requires authenticated userId; mount requireAuth before the rate limiter",
    );

  return userId;
}

const keyOf: Record<RateLimitKey, (c: Context) => string> = {
  clientIp: getClientIpKey,
  userId: getUserId,
};

const stores: MemoryStore[] = [];

/**
 * A policy from policies.ts as middleware, counting in this process's memory.
 * The API runs as one instance, so the counts are exact and no request waits
 * on a round trip to a shared store. With several instances each would count
 * on its own; see TODO.md before scaling out.
 *
 * RATE_LIMIT_MULTIPLIER raises every budget for the load test, which would
 * otherwise measure mostly 429s; production refuses to start with it set.
 */
function createLimiter(
  name: RateLimitName,
  { onlyGuests = false }: { onlyGuests?: boolean } = {},
) {
  const { windowMs, key } = RATE_LIMIT_POLICIES[name];
  const limit =
    RATE_LIMIT_POLICIES[name].limit * (getEnv().RATE_LIMIT_MULTIPLIER ?? 1);
  const store = new MemoryStore();
  stores.push(store);

  return rateLimiter({
    windowMs,
    limit,
    standardHeaders: "draft-6",
    keyGenerator: keyOf[key],
    store,
    message: rateLimitMessage,
    // Behind requireAuth, which says who's a guest.
    ...(onlyGuests ? { skip: (c: Context) => c.get("isGuest") !== true } : {}),
  });
}

export const authLoginRateLimiter = createLimiter("authLogin");
export const authCallbackRateLimiter = createLimiter("authCallback");
export const authLogoutRateLimiter = createLimiter("authLogout");
export const authMeRateLimiter = createLimiter("authMe");
export const authRefreshRateLimiter = createLimiter("authRefresh");
export const authGuestRateLimiter = createLimiter("authGuest");

export const jobRateLimiter = createLimiter("job");
export const conversationRateLimiter = createLimiter("conversation");
export const chatTurnRateLimiter = createLimiter("chatTurn");
/** Counts guests' turns only; anyone else passes. */
export const guestChatTurnRateLimiter = createLimiter("guestChatTurn", {
  onlyGuests: true,
});
export const modelRateLimiter = createLimiter("model");
export const imageReadRateLimiter = createLimiter("imageRead");
export const uploadRateLimiter = createLimiter("upload");
export const uploadConfirmRateLimiter = createLimiter("uploadConfirm");

/** Test-only: clears every count, so cases don't spend each other's budgets. */
export function resetRateLimits() {
  for (const store of stores) store.resetAll();
}
