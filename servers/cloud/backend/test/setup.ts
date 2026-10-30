import { vi } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  "postgresql://user:password@host.tld/dbname?option=value";
process.env.MQ_URL = "amqp://localhost";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
process.env.OPENROUTER_API_KEY = "test-key";
process.env.DEEPGRAM_API_KEY = "test-key";
process.env.WORKOS_API_KEY = "sk_test";
process.env.WORKOS_CLIENT_ID = "client_test";
process.env.CLIENT_URL = "http://localhost:5173";
process.env.API_BASE_URL = "http://localhost:3001";
process.env.PORT = "3001";
// Guest chat is on, as in production once its settings are set.
process.env.GUEST_SESSION_SECRET = "test-guest-session-secret-of-32-chars";
process.env.OPENROUTER_GUEST_API_KEY = "test-guest-key";

// Access tokens are verified against keys the tests sign with, not WorkOS's.
vi.mock("../src/auth/workosKeys", async () => {
  const { testKeys } = await import("./helpers/accessTokens");
  return { workosKeys: () => testKeys };
});

// createApp() runs a fail-fast preflight against real third-party services.
// Tests build the app against fake hosts, so stub the preflight to a no-op.
vi.mock("../src/startup", () => ({
  verifyApiServices: vi.fn(async () => {}),
}));
