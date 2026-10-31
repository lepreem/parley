import { describe, expect, it } from "vitest";
import type { Model } from "@openrouter/sdk/models";
import {
  guestModelsOf,
  offeredModels,
} from "../../src/ai/ai_chat_client/model_catalog";

const DAY = 24 * 60 * 60;

/** A model as OpenRouter lists it: only what the catalog reads. */
function listed(
  id: string,
  released: string,
  price: [input: number, output: number] | null,
  overrides: Partial<Model> = {},
): Model {
  return {
    id,
    name: id,
    canonicalSlug: id,
    created: Date.parse(released) / 1000,
    contextLength: 200_000,
    architecture: {
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      modality: "text+image->text",
    },
    pricing: price
      ? { prompt: String(price[0] / 1e6), completion: String(price[1] / 1e6) }
      : { prompt: "-1", completion: "-1" },
    ...overrides,
  } as Model;
}

/** The day after the newest of these was listed. */
function dayAfter(models: readonly Model[]): number {
  return (Math.max(...models.map((model) => model.created)) + DAY) * 1000;
}

function offered(...models: Model[]): string[] {
  return offeredModels(models, dayAfter(models)).map((model) => model.id);
}

/** Each archived id with the id of the model that replaces it. */
function archive(...models: Model[]): Record<string, string> {
  return Object.fromEntries(
    offeredModels(models, dayAfter(models)).flatMap((model) =>
      model.replacedBy ? [[model.id, model.replacedBy]] : [],
    ),
  );
}

describe("offeredModels", () => {
  it("describes what OpenRouter lists in the app's own terms", () => {
    const [model] = offeredModels(
      [
        listed("openai/gpt-6-luna", "2026-09-22", [0.1, 0.5], {
          name: "OpenAI: GPT-6 Luna",
          expirationDate: "2027-09-22",
        }),
      ],
      Date.parse("2026-10-31"),
    );
    expect(model).toEqual({
      id: "openai/gpt-6-luna",
      name: "OpenAI: GPT-6 Luna",
      contextTokens: 200_000,
      acceptsImages: true,
      released: "2026-09-22",
      aliases: [],
      pricing: { inputPerMillionTokens: 0.1, outputPerMillionTokens: 0.5 },
      replacedBy: null,
      retires: "2027-09-22",
    });
  });

  it("leaves out batch-only variants, which can't stream a reply", () => {
    expect(
      offered(
        listed("openai/gpt-6-luna", "2026-09-22", [0.1, 0.5]),
        listed("openai/gpt-6-luna:batch", "2026-09-22", [0.05, 0.25]),
      ),
    ).toEqual(["openai/gpt-6-luna"]);
  });

  it("folds an alias into the model it points at", () => {
    const models = offeredModels(
      [
        listed("openai/gpt-6-luna", "2026-09-22", [0.1, 0.5]),
        listed("~openai/gpt-luna-latest", "2026-09-11", [0.1, 0.5], {
          aliasTarget: { slug: "openai/gpt-6-luna", name: "GPT-6 Luna" },
        }),
      ],
      Date.parse("2026-10-31"),
    );
    expect(models.map(({ id, aliases }) => ({ id, aliases }))).toEqual([
      { id: "openai/gpt-6-luna", aliases: ["~openai/gpt-luna-latest"] },
    ]);
  });

  it("keeps an alias however long ago it was made", () => {
    const models = offeredModels(
      [
        listed("openai/gpt-6-luna", "2026-09-22", [0.1, 0.5]),
        listed("~openai/gpt-luna-latest", "2024-01-01", [0.1, 0.5], {
          aliasTarget: { slug: "openai/gpt-6-luna", name: "GPT-6 Luna" },
        }),
      ],
      Date.parse("2026-10-31"),
    );
    expect(models[0]?.aliases).toEqual(["~openai/gpt-luna-latest"]);
  });

  it("leaves out OpenAI's pro reasoning modes, but not other providers' pro models", () => {
    expect(
      offered(
        listed("openai/gpt-6-luna", "2026-09-22", [0.1, 0.5]),
        listed("openai/gpt-6-luna-pro", "2026-09-22", [0.1, 0.5]),
        listed("perplexity/sonar", "2026-09-22", [1, 1]),
        listed("perplexity/sonar-pro", "2026-09-22", [3, 15]),
      ),
    ).toEqual([
      "openai/gpt-6-luna",
      "perplexity/sonar",
      "perplexity/sonar-pro",
    ]);
  });

  it("leaves out models listed more than a year ago", () => {
    expect(
      offeredModels(
        [
          listed("openai/gpt-4.1", "2025-04-14", [2, 8]),
          listed("openai/gpt-6-luna", "2026-09-22", [0.1, 0.5]),
        ],
        Date.parse("2026-10-31"),
      ).map((model) => model.id),
    ).toEqual(["openai/gpt-6-luna"]);
  });
});

describe("archiving", () => {
  it("archives a model for a newer one of its family that costs no more", () => {
    expect(
      archive(
        listed("anthropic/claude-sonnet-4.6", "2026-02-17", [3, 15]),
        listed("anthropic/claude-sonnet-5.5", "2026-09-28", [2, 10]),
      ),
    ).toEqual({ "anthropic/claude-sonnet-4.6": "anthropic/claude-sonnet-5.5" });
  });

  it("keeps a model when the newer one costs more for input or output", () => {
    expect(
      archive(
        listed("openai/gpt-5.4", "2026-03-05", [2.5, 15]),
        listed("openai/gpt-5.5", "2026-04-24", [5, 30]),
      ),
    ).toEqual({});
  });

  it("keeps a flagship for a much cheaper newer tier", () => {
    expect(
      archive(
        listed("anthropic/claude-opus-5.5", "2026-09-22", [4, 20]),
        listed("anthropic/claude-haiku-5.5", "2026-10-07", [0.1, 0.5]),
      ),
    ).toEqual({});
  });

  it("archives a renamed tier at about the same price", () => {
    expect(
      archive(
        listed("openai/gpt-5.4-nano", "2026-03-17", [0.12, 0.6]),
        listed("openai/gpt-6-luna", "2026-09-22", [0.1, 0.5]),
      ),
    ).toEqual({ "openai/gpt-5.4-nano": "openai/gpt-6-luna" });
  });

  it("keeps models launched together, which are siblings", () => {
    expect(
      archive(
        listed("tencent/hy-mt2-7b", "2026-08-19", [0.074, 0.295]),
        listed("tencent/hy-mt2-1.8b", "2026-08-20", [0.044, 0.177]),
      ),
    ).toEqual({});
  });

  it("tells sizes of one family apart", () => {
    expect(
      archive(
        listed("qwen/qwen-3-72b-instruct", "2026-01-19", [0.36, 0.4]),
        listed("qwen/qwen-3-7b-instruct", "2026-03-16", [0.1, 0.2]),
      ),
    ).toEqual({});
  });

  it("keeps a model the newer one can't stand in for", () => {
    const older = listed("vendor/chat-1", "2026-01-01", [1, 1]);
    expect(
      archive(
        older,
        listed("vendor/chat-2", "2026-06-01", [1, 1], {
          architecture: {
            inputModalities: ["text"],
            outputModalities: ["text"],
            modality: "text->text",
          },
        }),
      ),
    ).toEqual({});
    expect(
      archive(
        older,
        listed("vendor/chat-2", "2026-06-01", [1, 1], { contextLength: 8000 }),
      ),
    ).toEqual({});
  });

  it("doesn't let a preview or a free variant replace anything", () => {
    expect(
      archive(
        listed("vendor/chat-1", "2026-01-01", [1, 1]),
        listed("vendor/chat-2-preview", "2026-06-01", [1, 1]),
        listed("vendor/chat-3:free", "2026-07-01", [0, 0]),
      ),
    ).toEqual({});
  });

  it("doesn't let a model made for code stand in for another family", () => {
    expect(
      archive(
        listed("openai/gpt-5.1", "2025-11-13", [1.25, 10]),
        listed("openai/gpt-5.1-codex-max", "2025-12-04", [1.25, 10]),
      ),
    ).toEqual({});
  });

  it("only compares models from the same provider", () => {
    expect(
      archive(
        listed("openai/gpt-5.4-nano", "2026-03-17", [0.12, 0.6], {
          name: "OpenAI: GPT-5.4 Nano",
        }),
        listed("anthropic/claude-haiku-5.5", "2026-10-07", [0.1, 0.5], {
          name: "Anthropic: Claude Haiku 5.5",
        }),
      ),
    ).toEqual({});
  });

  it("groups a provider's id prefixes by the name OpenRouter gives it", () => {
    expect(
      archive(
        listed("meta-llama/llama-4-70b", "2026-01-01", [1, 1], {
          name: "Meta: Llama 4 70B",
        }),
        listed("meta/llama-4.5-70b", "2026-06-01", [1, 1], {
          name: "Meta: Llama 4.5 70B",
        }),
      ),
    ).toEqual({ "meta-llama/llama-4-70b": "meta/llama-4.5-70b" });
  });

  it("never archives a model without a price", () => {
    expect(
      archive(
        listed("vendor/router", "2026-01-01", null),
        listed("vendor/chat-2", "2026-06-01", [0.5, 0.5]),
      ),
    ).toEqual({});
  });

  it("prefers a replacement from the model's own family", () => {
    expect(
      archive(
        listed("vendor/chat-1", "2026-01-01", [1, 1]),
        listed("vendor/chat-2", "2026-04-01", [0.8, 0.8]),
        listed("vendor/other-1", "2026-08-01", [0.9, 0.9]),
      ),
    ).toEqual({ "vendor/chat-1": "vendor/chat-2" });
  });

  it("points past a replacement that is archived itself", () => {
    expect(
      archive(
        listed("mistralai/mixtral-8x22b-instruct", "2025-12-01", [2, 6]),
        listed("mistralai/mistral-large-2602", "2026-02-01", [2, 6]),
        listed("mistralai/mistral-large-4-0", "2026-10-06", [0.7, 2.1]),
      ),
    ).toEqual({
      "mistralai/mixtral-8x22b-instruct": "mistralai/mistral-large-4-0",
      "mistralai/mistral-large-2602": "mistralai/mistral-large-4-0",
    });
  });
});

describe("guestModelsOf", () => {
  it("offers what costs no more than $0.10/$0.50, for input and output both", () => {
    const models = offeredModels(
      [
        listed("at-ceiling/model", "2026-09-01", [0.1, 0.5]),
        listed("cheap/model", "2026-09-01", [0.05, 0.2]),
        listed("free/model:free", "2026-09-01", [0, 0]),
        listed("dear-input/model", "2026-09-01", [0.15, 0.4]),
        listed("dear-output/model", "2026-09-01", [0.05, 0.6]),
        listed("openrouter/auto", "2026-09-01", null),
      ],
      Date.parse("2026-10-31"),
    );
    expect(guestModelsOf(models).map((model) => model.id)).toEqual([
      "at-ceiling/model",
      "cheap/model",
      "free/model:free",
    ]);
  });
});
