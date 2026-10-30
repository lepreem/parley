import "dotenv/config";
import { z } from "zod";
import { parseEnv as parseSharedEnv } from "@parley/server-kit/runtime/parseEnv";

const ANSI_RED = "\x1b[31m";
const ANSI_RESET = "\x1b[0m";

/**
 * Doppler injects these into every process it wraps, so their absence means
 * the values below came from .env instead. That fallback is legitimate but
 * silent, and a stale .env URL points the app at the wrong host in ways that
 * are painful to trace — so say so loudly, once.
 *
 * Not in production: there the environment comes from the platform and Doppler
 * is never in the picture, so the warning would fire on every boot and mean
 * nothing.
 */
let warnedAboutDopplerFallback = false;
function warnIfNotRunningUnderDoppler(): void {
  if (warnedAboutDopplerFallback) return;
  if (process.env.NODE_ENV === "production") return;
  if (process.env.DOPPLER_PROJECT && process.env.DOPPLER_CONFIG) return;
  warnedAboutDopplerFallback = true;
  console.error(
    `${ANSI_RED}[env] Doppler is not injecting this process — falling back to .env. URLs may point at the wrong host. Start it with \`doppler run -- <command>\`.${ANSI_RESET}`,
  );
}

function parseEnv<S extends z.ZodTypeAny>(schema: S, label: string) {
  warnIfNotRunningUnderDoppler();
  return parseSharedEnv(schema, label);
}

const nodeEnvSchema = z
  .enum(["development", "production", "test"])
  .default("development");

/**
 * Settings that point the app at stand-ins for its paid services, or loosen
 * its rate limits, so the load test (servers/cloud/loadtest) runs without a
 * bill. Each is read in the one place its client is built. None may be set in
 * production, where they would send real traffic to a mock or let real users
 * past the limits.
 */
const LOADTEST_OVERRIDES = [
  "OPENROUTER_BASE_URL",
  "DEEPGRAM_BASE_URL",
  "WORKOS_API_BASE_URL",
  "RATE_LIMIT_MULTIPLIER",
] as const;

/**
 * Guest chat runs only when both of its settings are there: the secret that
 * signs guest sessions, and an OpenRouter key of its own, so what guests
 * spend is capped by that key's credit limit and never reaches the main key.
 * One without the other is a mistake, not a choice.
 */
const GUEST_SETTINGS = ["GUEST_SESSION_SECRET", "OPENROUTER_GUEST_API_KEY"];

function requireGuestSettingsTogether(
  env: Partial<Record<string, unknown>>,
  ctx: z.RefinementCtx,
) {
  const set = GUEST_SETTINGS.filter((key) => env[key] !== undefined);
  if (set.length === 0 || set.length === GUEST_SETTINGS.length) return;
  for (const key of GUEST_SETTINGS) {
    if (set.includes(key)) continue;
    ctx.addIssue({
      code: "custom",
      path: [key],
      message: `is needed for guest chat, since ${set.join(", ")} is set`,
    });
  }
}

function rejectLoadtestOverridesInProduction(
  env: { NODE_ENV: string } & Partial<Record<string, unknown>>,
  ctx: z.RefinementCtx,
) {
  if (env.NODE_ENV !== "production") return;
  for (const key of LOADTEST_OVERRIDES) {
    if (env[key] === undefined) continue;
    ctx.addIssue({
      code: "custom",
      path: [key],
      message: "is a load-test override and can't be set in production",
    });
  }
}

/** Exported for its own unit test; the app reads env through getEnv. */
export const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    MQ_URL: z.string().min(1),
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    OPENROUTER_API_KEY: z.string().min(1),
    DEEPGRAM_API_KEY: z.string().min(1),
    WORKOS_API_KEY: z.string().min(1),
    WORKOS_CLIENT_ID: z.string().min(1),
    CLIENT_URL: z.string().url(),
    API_BASE_URL: z.string().url(),
    NODE_ENV: nodeEnvSchema,
    PORT: z.coerce.number().int().positive().default(3001),
    /**
     * The built client, which the API serves when it's there. Relative to the
     * working directory, like the migrations; the image sets its own.
     */
    CLIENT_DIR: z.string().min(1).default("../../../client/dist"),
    OPENROUTER_BASE_URL: z.string().url().optional(),
    DEEPGRAM_BASE_URL: z.string().url().optional(),
    WORKOS_API_BASE_URL: z.string().url().optional(),
    /** Every rate limit's budget is multiplied by this. */
    RATE_LIMIT_MULTIPLIER: z.coerce.number().positive().optional(),
    /** Signs guest session tokens (HS256). `openssl rand -base64 32`. */
    GUEST_SESSION_SECRET: z.string().min(32).optional(),
    /**
     * What guests' turns are billed to: a key with a credit limit set on it
     * in OpenRouter, which is the hard cap on guest spending.
     */
    OPENROUTER_GUEST_API_KEY: z.string().min(1).optional(),
  })
  .superRefine(rejectLoadtestOverridesInProduction)
  .superRefine(requireGuestSettingsTogether);

type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;
export function getEnv(): Env {
  cachedEnv ??= parseEnv(envSchema, "api");
  return cachedEnv;
}

/** Whether guests can chat: both guest settings are there. */
export function guestChatEnabled(): boolean {
  return getEnv().OPENROUTER_GUEST_API_KEY !== undefined;
}

/**
 * For the one-shots that only touch the database (migrate, baseline) and
 * drizzle-kit: their container is given DATABASE_URL and nothing else.
 */
export function getDatabaseUrl(): string {
  return parseEnv(z.object({ DATABASE_URL: z.string().min(1) }), "database")
    .DATABASE_URL;
}
