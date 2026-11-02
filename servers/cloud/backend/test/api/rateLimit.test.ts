import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockLimit,
  mockWhere,
  mockFrom,
  mockSelect,
  mockGetAuthSessionFromCode,
  mockgetChatModelData,
} = vi.hoisted(() => ({
  mockLimit: vi.fn(),
  mockWhere: vi.fn(),
  mockFrom: vi.fn(),
  mockSelect: vi.fn(),
  mockGetAuthSessionFromCode: vi.fn(),
  mockgetChatModelData: vi.fn(),
}));

vi.mock("../../src/db", async () => ({
  db: { select: mockSelect },
  ...(await import("../helpers/dbTableStubs")).tableStubs,
}));

vi.mock("../../src/auth/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/auth/auth")>();
  return {
    ...actual,
    workos: {
      ...actual.workos,
      getAuthSessionFromCode: mockGetAuthSessionFromCode,
    },
  };
});

vi.mock("../../src/ai/ai_chat_client/ai_chat_client", async (importActual) => {
  const actual =
    await importActual<
      typeof import("../../src/ai/ai_chat_client/ai_chat_client")
    >();
  return {
    ...actual, // preserves DEFAULT_MODELS, used at upload.schema import time
    getChatModelData: mockgetChatModelData,
  };
});

import { createApp } from "../../src/app";
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import { authedHeaders, sessionCookieHeader } from "../helpers/session";

const audioUploadId = "550e8400-e29b-41d4-a716-446655440000";

describe("rate limiting", () => {
  beforeEach(() => {
    resetRateLimits();
    vi.clearAllMocks();
    mockGetAuthSessionFromCode.mockRejectedValue(
      new Error("WorkOS unavailable"),
    );
    mockgetChatModelData.mockResolvedValue({});
    mockWhere.mockImplementation(() => ({ limit: mockLimit }));
    // The job read joins its attachment; the transcript read doesn't.
    mockFrom.mockImplementation(() => ({
      innerJoin: () => ({ where: mockWhere }),
      where: mockWhere,
    }));
    mockSelect.mockImplementation(() => ({ from: mockFrom }));
    // The transcript-view handler now reads the job and its transcript in
    // parallel; the second (transcript) read defaults to none unless overridden.
    mockLimit.mockResolvedValue([]);
  });

  it("allows requests under the limit", async () => {
    mockLimit.mockResolvedValueOnce([
      {
        audioUploadId,
        fileName: "clip.mp3",
        status: "completed",
        error: null,
      },
    ]);
    const res = await (
      await createApp()
    ).request(`http://localhost/jobs/transcribe/${audioUploadId}`, {
      headers: { Cookie: await sessionCookieHeader("user_01") },
    });
    expect(res.status).toBe(200);
  });

  it("returns RateLimit draft-6 headers on success", async () => {
    mockLimit.mockResolvedValueOnce([
      {
        audioUploadId,
        fileName: "clip.mp3",
        status: "completed",
        error: null,
      },
    ]);
    const res = await (
      await createApp()
    ).request(`http://localhost/jobs/${audioUploadId}`, {
      headers: { Cookie: await sessionCookieHeader("user_01") },
    });
    expect(res.headers.get("RateLimit-Limit")).toBe("100");
    expect(res.headers.get("RateLimit-Remaining")).toBeTruthy();
  });

  it("returns 429 when auth callback limit is exceeded", async () => {
    const app = await createApp();
    for (let i = 0; i < 20; i++) {
      const res = await app.request("http://localhost/auth/callback?code=test");
      expect(res.status).not.toBe(429);
    }
    const res = await app.request("http://localhost/auth/callback?code=test");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      message: "Too many requests, please try again later.",
    });
    expect(mockGetAuthSessionFromCode).toHaveBeenCalledTimes(20);
  });

  describe("keyed on the client IP Caddy reports in X-Real-IP", () => {
    const callback =
      (headers: Record<string, string>) =>
      (app: Awaited<ReturnType<typeof createApp>>) =>
        app.request("http://localhost/auth/callback?code=test", { headers });

    it("gives each client its own budget", async () => {
      const app = await createApp();
      const first = callback({ "X-Real-IP": "203.0.113.1" });
      for (let i = 0; i < 20; i++) await first(app);

      expect((await first(app)).status).toBe(429);
      expect(
        (await callback({ "X-Real-IP": "203.0.113.2" })(app)).status,
      ).not.toBe(429);
    });

    // A duplicated header reaches Hono joined with ", ", and garbage is
    // garbage: neither may become a key the client chose.
    it("doesn't trust a value that isn't a single IP", async () => {
      const app = await createApp();
      for (let i = 0; i < 20; i++) {
        await callback({ "X-Real-IP": `203.0.113.1, 198.51.100.${i}` })(app);
      }

      expect((await callback({ "X-Real-IP": "not-an-ip" })(app)).status).toBe(
        429,
      );
    });
  });
});

describe("GET /models rate limiting", () => {
  beforeEach(() => {
    resetRateLimits();
    vi.clearAllMocks();
    mockgetChatModelData.mockResolvedValue({});
  });

  it("returns 429 when model limit is exceeded", async () => {
    const app = await createApp();
    const cookie = await sessionCookieHeader("user_01");
    for (let i = 0; i < 100; i++) {
      const res = await app.request("http://localhost/models", {
        headers: { Cookie: cookie },
      });
      expect(res.status).not.toBe(429);
    }
    const res = await app.request("http://localhost/models", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      message: "Too many requests, please try again later.",
    });
  });

  it("gives each user their own budget", async () => {
    const app = await createApp();
    const models = async (userId: string) =>
      app.request("http://localhost/models", {
        headers: { Cookie: await sessionCookieHeader(userId) },
      });
    for (let i = 0; i < 100; i++) await models("user_01");

    expect((await models("user_01")).status).toBe(429);
    expect((await models("user_02")).status).not.toBe(429);
  });
});

describe("chat turn rate limiting", () => {
  const conversationId = "550e8400-e29b-41d4-a716-446655440000";

  beforeEach(() => {
    resetRateLimits();
    vi.clearAllMocks();
  });

  // Each one is a paid model call, so it has a budget of its own. An empty
  // body is a 400, but it has already spent the budget by then.
  it("gives sending a budget of its own, apart from reading", async () => {
    const app = await createApp();
    const headers = await authedHeaders("user_01");
    const send = () =>
      app.request(`http://localhost/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
      });

    for (let i = 0; i < 50; i++) expect((await send()).status).toBe(400);
    const res = await send();
    expect(res.status).toBe(429);
    expect(res.headers.get("RateLimit-Limit")).toBe("50");

    const read = await app.request(
      `http://localhost/conversations/${conversationId}`,
      { headers },
    );
    expect(read.status).not.toBe(429);
    expect(read.headers.get("RateLimit-Limit")).toBe("100");
  });
});
