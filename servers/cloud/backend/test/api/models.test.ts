import { describe, it, expect, vi, beforeEach } from "vitest";

// Only hoist the mock function factory — no async work here
const { mockListChatModels } = vi.hoisted(() => ({
  mockListChatModels: vi.fn(),
}));

vi.mock("../../src/ai/ai_chat_client/ai_chat_client", async (importActual) => {
  // importActual is the correct way to get real values inside vi.mock
  const actual =
    await importActual<
      typeof import("../../src/ai/ai_chat_client/ai_chat_client")
    >();
  return {
    ...actual,
    chat: { ...actual.chat, listModels: mockListChatModels },
  };
});

// Now this import gets the mocked module, with real DEFAULT_MODELS intact

import { createApp } from "../../src/app";
import { sessionCookieHeader } from "../helpers/session";

const MODEL_ID = "openai/gpt-4o-mini";

const sampleModel = {
  id: MODEL_ID,
  name: "GPT-4o Mini",
  contextTokens: 128000,
  acceptsImages: true,
  released: null,
  aliases: [],
  replacedBy: null,
  retires: null,
};

describe("GET /models/chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListChatModels.mockResolvedValue([sampleModel]);
  });

  it("returns 401 without a session cookie", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/models/chat");
    expect(res.status).toBe(401);
    expect(mockListChatModels).not.toHaveBeenCalled();
  });

  it("returns the chat models for a valid session", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/models/chat", {
      headers: { Cookie: await sessionCookieHeader("user_01") },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: [sampleModel] });
    expect(mockListChatModels).toHaveBeenCalledTimes(1);
  });

  it("gzips the catalog when the client accepts it", async () => {
    // The real catalog is ~50KB of JSON sent to every client; the sample here
    // only has to clear the middleware's 1KB threshold.
    mockListChatModels.mockResolvedValue(
      Array.from({ length: 40 }, (_, index) => ({
        ...sampleModel,
        id: `vendor/model-${index}`,
      })),
    );

    const res = await (
      await createApp()
    ).request("http://localhost/models/chat", {
      headers: {
        Cookie: await sessionCookieHeader("user_01"),
        "Accept-Encoding": "gzip",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
  });

  it("revalidates with an ETag instead of resending the catalog", async () => {
    const app = await createApp();
    const cookie = await sessionCookieHeader("user_01");

    const first = await app.request("http://localhost/models/chat", {
      headers: { Cookie: cookie },
    });
    const tag = first.headers.get("ETag");
    expect(first.status).toBe(200);
    expect(tag).toBeTruthy();
    // Never served from a stale copy: a deploy's catalog reaches the client
    // the next time it asks.
    expect(first.headers.get("Cache-Control")).toBe("private, no-cache");

    const second = await app.request("http://localhost/models/chat", {
      headers: { Cookie: cookie, "If-None-Match": tag as string },
    });

    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    // The header has to survive onto the 304, or the browser stops caching.
    expect(second.headers.get("Cache-Control")).toBe("private, no-cache");
  });

  it("returns RateLimit draft-6 headers on success", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/models/chat", {
      headers: { Cookie: await sessionCookieHeader("user_01") },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("RateLimit-Limit")).toBe("100");
    expect(res.headers.get("RateLimit-Remaining")).toBeTruthy();
  });
});

describe("GET /models/transcription", () => {
  it("is gone: the cloud picks the transcription model itself", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/models/transcription", {
      headers: { Cookie: await sessionCookieHeader("user_01") },
    });
    expect(res.status).toBe(404);
  });
});
