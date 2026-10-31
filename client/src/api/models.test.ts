import { describe, expect, it, vi } from "vitest";

// The fetchers reach the app's config, which reads the page; the rules
// tested here don't.
vi.mock("./http", () => ({}));

import { archivedModels, type ChatModel } from "./models";

function model(
  id: string,
  released: string | null,
  price: [input: number, output: number] | null,
  overrides: Partial<ChatModel> = {},
): ChatModel {
  return {
    id,
    name: id,
    contextTokens: 200_000,
    acceptsImages: true,
    released,
    pricing: price && {
      inputPerMillionTokens: price[0],
      outputPerMillionTokens: price[1],
    },
    ...overrides,
  };
}

/** Each archived id with the id of the model that replaces it. */
function archive(...models: ChatModel[]): Record<string, string> {
  return Object.fromEntries(
    [...archivedModels(models)].map(([id, by]) => [id, by.id]),
  );
}

describe("archivedModels", () => {
  it("archives a model for a newer one of its family that costs no more", () => {
    expect(
      archive(
        model("anthropic/claude-sonnet-4.5", "2025-09-29", [3, 15]),
        model("anthropic/claude-sonnet-5.5", "2026-09-28", [2, 10]),
      ),
    ).toEqual({ "anthropic/claude-sonnet-4.5": "anthropic/claude-sonnet-5.5" });
  });

  it("keeps a model when the newer one costs more for input or output", () => {
    expect(
      archive(
        model("openai/gpt-4.1", "2025-04-14", [2, 8]),
        model("openai/gpt-5", "2025-08-07", [1.25, 10]),
      ),
    ).toEqual({});
  });

  it("keeps a flagship for a much cheaper newer tier", () => {
    expect(
      archive(
        model("anthropic/claude-opus-5.5", "2026-09-22", [4, 20]),
        model("anthropic/claude-haiku-5.5", "2026-10-07", [0.1, 0.5]),
      ),
    ).toEqual({});
  });

  it("archives a renamed tier at about the same price", () => {
    expect(
      archive(
        model("openai/gpt-4o-mini", "2024-07-18", [0.15, 0.6]),
        model("openai/gpt-6-luna", "2026-09-22", [0.1, 0.5]),
      ),
    ).toEqual({ "openai/gpt-4o-mini": "openai/gpt-6-luna" });
  });

  it("keeps models launched together, which are siblings", () => {
    expect(
      archive(
        model("tencent/hy-mt2-7b", "2026-08-19", [0.074, 0.295]),
        model("tencent/hy-mt2-1.8b", "2026-08-20", [0.044, 0.177]),
      ),
    ).toEqual({});
  });

  it("tells sizes of one family apart", () => {
    expect(
      archive(
        model("qwen/qwen-2.5-72b-instruct", "2024-09-19", [0.36, 0.4]),
        model("qwen/qwen-2.5-7b-instruct", "2024-10-16", [0.1, 0.2]),
      ),
    ).toEqual({});
  });

  it("keeps a model the newer one can't stand in for", () => {
    expect(
      archive(
        model("vendor/chat-1", "2025-01-01", [1, 1]),
        model("vendor/chat-2", "2026-01-01", [1, 1], { acceptsImages: false }),
      ),
    ).toEqual({});
    expect(
      archive(
        model("vendor/chat-1", "2025-01-01", [1, 1]),
        model("vendor/chat-2", "2026-01-01", [1, 1], { contextTokens: 8000 }),
      ),
    ).toEqual({});
  });

  it("doesn't let a preview, a free variant or an alias replace anything", () => {
    expect(
      archive(
        model("vendor/chat-1", "2025-01-01", [1, 1]),
        model("vendor/chat-2-preview", "2026-01-01", [1, 1]),
        model("vendor/chat-3:free", "2026-02-01", [0, 0]),
        model("~vendor/chat-latest", "2026-03-01", [1, 1]),
      ),
    ).toEqual({});
  });

  it("doesn't let a model made for code stand in for another family", () => {
    expect(
      archive(
        model("openai/gpt-5.1", "2025-11-13", [1.25, 10]),
        model("openai/gpt-5.1-codex-max", "2025-12-04", [1.25, 10]),
      ),
    ).toEqual({});
  });

  it("only compares models from the same provider", () => {
    expect(
      archive(
        model("openai/gpt-4o-mini", "2024-07-18", [0.15, 0.6]),
        model("anthropic/claude-haiku-5.5", "2026-10-07", [0.1, 0.5]),
      ),
    ).toEqual({});
  });

  it("never archives a model without a price or a date", () => {
    expect(
      archive(
        model("vendor/router", "2025-01-01", null),
        model("vendor/undated", null, [1, 1]),
        model("vendor/chat-2", "2026-01-01", [0.5, 0.5]),
      ),
    ).toEqual({});
  });

  it("prefers a replacement from the model's own family", () => {
    expect(
      archive(
        model("vendor/chat-1", "2025-01-01", [1, 1]),
        model("vendor/chat-2", "2025-06-01", [0.8, 0.8]),
        model("vendor/other-1", "2026-01-01", [0.9, 0.9]),
      ),
    ).toEqual({ "vendor/chat-1": "vendor/chat-2" });
  });

  it("points past a replacement that is archived itself", () => {
    expect(
      archive(
        model("mistralai/mixtral-8x22b-instruct", "2024-04-17", [2, 6]),
        model("mistralai/mistral-large-2407", "2024-11-19", [2, 6]),
        model("mistralai/mistral-large-4-0", "2026-10-06", [0.7, 2.1]),
      ),
    ).toEqual({
      "mistralai/mixtral-8x22b-instruct": "mistralai/mistral-large-4-0",
      "mistralai/mistral-large-2407": "mistralai/mistral-large-4-0",
    });
  });
});
