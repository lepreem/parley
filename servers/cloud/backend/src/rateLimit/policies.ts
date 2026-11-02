/**
 * Every rate limit the API enforces, as plain data: how many requests a
 * window allows, and whose budget they count against. Nothing here knows
 * about Hono or where the counts live, so the table can move into a load
 * balancer's config as it is. rateLimit.middleware.ts turns each entry into
 * middleware, and the routers mount it.
 *
 * What a budget belongs to:
 * - clientIp: the client's address, as the server's Caddy proxy reports it
 *   in X-Real-IP.
 * - userId: the signed-in user, from the session cookie. In the API that
 *   means requireAuth runs first; anything enforcing it outside the API has
 *   to verify the WorkOS access token in that cookie to know the user.
 */

export type RateLimitKey = "clientIp" | "userId";

type RateLimitPolicy = {
  limit: number;
  windowMs: number;
  key: RateLimitKey;
};

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const RATE_LIMIT_POLICIES = {
  authLogin: { limit: 60, windowMs: FIFTEEN_MINUTES_MS, key: "clientIp" },
  authCallback: { limit: 20, windowMs: FIFTEEN_MINUTES_MS, key: "clientIp" },
  authLogout: { limit: 60, windowMs: FIFTEEN_MINUTES_MS, key: "clientIp" },
  authMe: { limit: 200, windowMs: FIFTEEN_MINUTES_MS, key: "clientIp" },
  /** Each signed-in user refreshes every few minutes, so this sits with /me. */
  authRefresh: { limit: 200, windowMs: FIFTEEN_MINUTES_MS, key: "clientIp" },
  /** Starting a guest session makes a user row, and nothing else. */
  authGuest: { limit: 10, windowMs: FIFTEEN_MINUTES_MS, key: "clientIp" },

  job: { limit: 100, windowMs: FIFTEEN_MINUTES_MS, key: "userId" },
  conversation: { limit: 100, windowMs: FIFTEEN_MINUTES_MS, key: "userId" },

  /**
   * Sending or editing a message: each one is a paid model call. It has its
   * own budget rather than sharing the conversation one, so opening chats
   * can't use up a user's turns and turns aren't only bounded by reads.
   */
  chatTurn: { limit: 50, windowMs: FIFTEEN_MINUTES_MS, key: "userId" },
  /**
   * Guests' turns, on top of chatTurn, and by address: a new guest is one
   * click away, so a per-user budget wouldn't hold anyone to it. What stops
   * guest spending for good is the credit limit on OPENROUTER_GUEST_API_KEY;
   * this keeps one address from using all of it.
   */
  guestChatTurn: { limit: 10, windowMs: ONE_DAY_MS, key: "clientIp" },
  model: { limit: 100, windowMs: FIFTEEN_MINUTES_MS, key: "userId" },

  /**
   * Reading a stored image back is not an upload: it reads a row and re-signs
   * at most once a week. A single chat turn can ask for one per attachment,
   * so putting these on the 30-request upload budget would exhaust it in a
   * few renders — they get a read-sized budget instead.
   */
  imageRead: { limit: 200, windowMs: FIFTEEN_MINUTES_MS, key: "userId" },

  /** Minting an upload URL is what stands for an upload, so it spends this. */
  upload: { limit: 30, windowMs: FIFTEEN_MINUTES_MS, key: "userId" },

  /**
   * Confirming moves no bytes and needs an object a mint already paid for, so
   * it gets its own budget rather than halving how many files a user can
   * send. Twice the upload budget leaves room for a retried confirm on every
   * upload.
   */
  uploadConfirm: { limit: 60, windowMs: FIFTEEN_MINUTES_MS, key: "userId" },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitName = keyof typeof RATE_LIMIT_POLICIES;
