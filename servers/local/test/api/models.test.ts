import { describe, it, expect, vi, beforeEach } from "vitest";

// Only hoist the mock function factory — no async work here
const { mockListChatModels } = vi.hoisted(() => ({
  mockListChatModels: vi.fn(),
}));

vi.mock("../../core/ai/ai_chat_client", async (importActual) => {
  // importActual is the correct way to get real values inside vi.mock
  const actual =
    await importActual<typeof import("../../core/ai/ai_chat_client")>();
  return {
    ...actual, // preserves DEFAULT_MODELS and anything else
    listChatModels: mockListChatModels, // override only what needs mocking
  };
});

// Now this import gets the mocked module, with real DEFAULT_MODELS intact

import { createApp } from "../../api/app";

const sampleModel = {
  id: "sonnet",
  name: "Claude Sonnet",
  contextTokens: 200_000,
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

  it("returns the chat models", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/models/chat");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: [sampleModel] });
    expect(mockListChatModels).toHaveBeenCalledTimes(1);
  });

  it("gzips the catalog when the client accepts it", async () => {
    // The real catalog is under the middleware's 1KB threshold; this one
    // clears it.
    mockListChatModels.mockResolvedValue(
      Array.from({ length: 40 }, (_, index) => ({
        ...sampleModel,
        id: `model-${index}`,
      })),
    );

    const res = await (
      await createApp()
    ).request("http://localhost/models/chat", {
      headers: {
        "Accept-Encoding": "gzip",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
  });

  it("revalidates with an ETag instead of resending the catalog", async () => {
    const app = await createApp();

    const first = await app.request("http://localhost/models/chat");
    const tag = first.headers.get("ETag");
    expect(first.status).toBe(200);
    expect(tag).toBeTruthy();
    expect(first.headers.get("Cache-Control")).toContain("max-age=300");

    const second = await app.request("http://localhost/models/chat", {
      headers: { "If-None-Match": tag as string },
    });

    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    // The header has to survive onto the 304, or the browser stops caching.
    expect(second.headers.get("Cache-Control")).toContain("max-age=300");
  });
});

describe("GET /models/transcription", () => {
  it("is gone: the server picks the transcription model itself", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/models/transcription");
    expect(res.status).toBe(404);
  });
});
