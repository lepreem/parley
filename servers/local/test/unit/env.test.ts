import { homedir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { apiEnvSchema, baseEnvSchema } from "../../core/env";

const validBase = {
  DATA_DIR: "/tmp/parley",
  NODE_ENV: "test" as const,
};

describe("apiEnvSchema", () => {
  it("accepts the base env, defaulting the rest", () => {
    const result = apiEnvSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      PORT: 3002,
      CLIENT_DIR: "../../client/dist",
      ALLOWED_HOSTS: [],
    });
  });

  it("reads ALLOWED_HOSTS as a list of lowercase names", () => {
    const result = apiEnvSchema.safeParse({
      ...validBase,
      ALLOWED_HOSTS: " MacBook.tail1234.ts.net, ,other.example ",
    });
    expect(result.data?.ALLOWED_HOSTS).toEqual([
      "macbook.tail1234.ts.net",
      "other.example",
    ]);
  });
});

describe("baseEnvSchema", () => {
  it("accepts a valid base env", () => {
    const result = baseEnvSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it("keeps the data in ~/.parley unless told otherwise", () => {
    const result = baseEnvSchema.safeParse({});
    expect(result.data?.DATA_DIR).toBe(path.join(homedir(), ".parley"));
  });
});
