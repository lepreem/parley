import { describe, it, expect } from "vitest";
import { envSchema, getDatabaseUrl } from "../../src/env";

const validEnv = {
  DATABASE_URL: "postgres://localhost:5432/test",
  MQ_URL: "amqp://localhost",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-key",
  OPENROUTER_API_KEY: "test-key",
  DEEPGRAM_API_KEY: "test-key",
  NODE_ENV: "test" as const,
  WORKOS_API_KEY: "sk_test",
  WORKOS_CLIENT_ID: "client_test",
  CLIENT_URL: "http://localhost:5173",
  API_BASE_URL: "http://localhost:3001",
};

describe("envSchema", () => {
  it("accepts a valid env", () => {
    const result = envSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
  });

  it("rejects an empty key", () => {
    const result = envSchema.safeParse({
      ...validEnv,
      OPENROUTER_API_KEY: "",
    });
    expect(result.success).toBe(false);
  });

  it("accepts guest chat's settings together", () => {
    const result = envSchema.safeParse({
      ...validEnv,
      GUEST_SESSION_SECRET: "a".repeat(32),
      OPENROUTER_GUEST_API_KEY: "guest-key",
    });
    expect(result.success).toBe(true);
  });

  it.each([
    [{ GUEST_SESSION_SECRET: "a".repeat(32) }, "OPENROUTER_GUEST_API_KEY"],
    [{ OPENROUTER_GUEST_API_KEY: "guest-key" }, "GUEST_SESSION_SECRET"],
  ])("refuses one guest chat setting without the other", (set, missing) => {
    const result = envSchema.safeParse({ ...validEnv, ...set });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      [missing],
    ]);
  });

  it("refuses a short guest session secret", () => {
    const result = envSchema.safeParse({
      ...validEnv,
      GUEST_SESSION_SECRET: "too-short",
      OPENROUTER_GUEST_API_KEY: "guest-key",
    });
    expect(result.success).toBe(false);
  });

  const loadtestOverrides = {
    OPENROUTER_BASE_URL: "http://mocks:4000/openrouter",
    DEEPGRAM_BASE_URL: "http://mocks:4000/deepgram",
    WORKOS_API_BASE_URL: "http://mocks:4000/workos",
    RATE_LIMIT_MULTIPLIER: "1000",
  };

  it("accepts the load-test overrides outside production", () => {
    const result = envSchema.safeParse({
      ...validEnv,
      ...loadtestOverrides,
    });
    expect(result.success).toBe(true);
  });

  it.each(Object.entries(loadtestOverrides))(
    "refuses %s in production",
    (key, value) => {
      const result = envSchema.safeParse({
        ...validEnv,
        NODE_ENV: "production",
        [key]: value,
      });
      expect(result.success).toBe(false);
    },
  );

  it("requires MQ_URL", () => {
    const { MQ_URL: _omitted, ...withoutMq } = validEnv;
    expect(envSchema.safeParse(withoutMq).success).toBe(false);
  });

  it.each(["CLIENT_URL", "API_BASE_URL"] as const)(
    "requires %s rather than defaulting to localhost",
    (key) => {
      const { [key]: _omitted, ...withoutUrl } = validEnv;
      const result = envSchema.safeParse(withoutUrl);
      expect(result.success).toBe(false);
    },
  );
});

describe("getDatabaseUrl", () => {
  // The migrate container is given DATABASE_URL and nothing else.
  it("reads DATABASE_URL without needing the rest", () => {
    expect(getDatabaseUrl()).toBe(process.env.DATABASE_URL);
  });
});
