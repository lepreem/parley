import type {
  ChatModel,
  ModelPricing,
  ModelsResponse,
  TranscribeModel,
} from "@parley/contract";
import { apiJson } from "./http";
import type { Server } from "./server";

export type { ChatModel, ModelPricing, TranscribeModel };

async function fetchModels<T>(server: Server, path: string): Promise<T[]> {
  const data = await apiJson<ModelsResponse<T>>(server, path);
  if (!Array.isArray(data?.models)) throw new Error("Invalid models response");
  return data.models;
}

export function fetchChatModels(server: Server): Promise<ChatModel[]> {
  return fetchModels<ChatModel>(server, "/models/chat");
}

export function fetchTranscriptionModels(
  server: Server,
): Promise<TranscribeModel[]> {
  return fetchModels<TranscribeModel>(server, "/models/transcription");
}

/** Fall back to the first available model when the preferred one isn't offered. */
export function resolveDefaultModel(
  modelIds: string[],
  preferredModelId: string,
): string | null {
  if (modelIds.includes(preferredModelId)) return preferredModelId;
  return modelIds[0] ?? null;
}

/* ------------------------------------------------------------------ naming */

// OpenRouter ids are "<provider>/<model>" and its names are "Provider: Model",
// so both the grouping key and a clean display name come from the catalog
// itself. This map only covers the fallback path, where a name arrives without
// its prefix.
const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  "meta-llama": "Meta",
  mistralai: "Mistral",
  deepseek: "DeepSeek",
  "x-ai": "xAI",
  qwen: "Qwen",
  cohere: "Cohere",
  perplexity: "Perplexity",
  microsoft: "Microsoft",
  nvidia: "NVIDIA",
  amazon: "Amazon",
  ai21: "AI21",
};

// A leading "~" marks OpenRouter's alias ids ("~openai/gpt-chat-latest"), which
// belong to the same provider as the model they point at.
function providerSlug(modelId: string): string {
  const [slug] = modelId.split("/");
  return slug && slug !== modelId ? slug.replace(/^~/, "") : "other";
}

function labelForSlug(slug: string): string {
  if (PROVIDER_LABELS[slug]) return PROVIDER_LABELS[slug];
  return slug
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** "Anthropic: Claude Sonnet 4.5" becomes { provider, name } for display. */
export function describeModel(model: ChatModel): {
  provider: string;
  name: string;
} {
  const raw = model.name.trim() || model.id;
  const separator = raw.indexOf(": ");
  if (separator > 0) {
    return {
      provider: raw.slice(0, separator).trim(),
      name: raw.slice(separator + 2).trim(),
    };
  }
  return { provider: labelForSlug(providerSlug(model.id)), name: raw };
}

/* ---------------------------------------------------- message requirements */

/**
 * What the message being written needs from a model. Derived from what the
 * composer is actually carrying, so the picker can hide models that would be
 * rejected — the API refuses a turn whose model can't read an attached image,
 * and a transcript longer than the context window can't be answered.
 */
export type MessageRequirements = {
  image: boolean;
  /** Rough token estimate of the prompt this turn will send. */
  tokens: number;
};

/** Four characters per token is the usual English approximation. */
export const CHARS_PER_TOKEN = 4;

export function meetsRequirements(
  model: ChatModel,
  requirements: MessageRequirements,
): boolean {
  if (requirements.image && !model.acceptsImages) return false;
  // An unknown context length is not evidence the model is too small.
  if (model.contextTokens !== null && requirements.tokens > model.contextTokens)
    return false;
  return true;
}

/* -------------------------------------------------------------------- price */

/** A model's price at a glance: one to three dollar signs, then a plus. */
export type PriceTier =
  { kind: "free" } | { kind: "paid"; dollars: 1 | 2 | 3; premium: boolean };

/**
 * One price per model to rank by, in dollars per million tokens: three input
 * tokens to every output one. A turn here replays history and transcripts,
 * so it reads far more than the model writes.
 */
function blendedPrice(pricing: ModelPricing): number {
  return (
    (3 * pricing.inputPerMillionTokens + pricing.outputPerMillionTokens) / 4
  );
}

/**
 * The blended price each tier stays under. Small models land on $, mid-size
 * open ones on $$, the flagship models on $$$, and the most expensive ones
 * on $$$+.
 */
const ONE_DOLLAR_UNDER = 0.5;
const TWO_DOLLARS_UNDER = 2;
const THREE_DOLLARS_UNDER = 8;

/** Null when the model has no per-token price to rank it by. */
export function priceTier(pricing: ModelPricing | null): PriceTier | null {
  if (!pricing) return null;
  const price = blendedPrice(pricing);
  if (price === 0) return { kind: "free" };
  if (price < ONE_DOLLAR_UNDER)
    return { kind: "paid", dollars: 1, premium: false };
  if (price < TWO_DOLLARS_UNDER)
    return { kind: "paid", dollars: 2, premium: false };
  return { kind: "paid", dollars: 3, premium: price >= THREE_DOLLARS_UNDER };
}

function formatDollars(amount: number): string {
  // A cent is where two decimals stop saying anything.
  return amount > 0 && amount < 0.01
    ? `$${amount.toPrecision(2)}`
    : `$${amount.toFixed(2)}`;
}

/** "$0.15 in · $0.60 out per 1M tokens" — the exact price behind a tier. */
export function describePricing(pricing: ModelPricing): string {
  return `${formatDollars(pricing.inputPerMillionTokens)} in · ${formatDollars(
    pricing.outputPerMillionTokens,
  )} out per 1M tokens`;
}

/* ----------------------------------------------------------------- archive */

/** Launches closer together than this are siblings, not one replacing another. */
const SAME_LAUNCH_DAYS = 14;

/**
 * How much cheaper a replacement from another family may be. Further below,
 * it's a smaller tier (Haiku, not a new Sonnet), not the same tier renamed
 * (GPT-4o mini to GPT-6 Luna).
 */
const RENAMED_TIER_PRICE_RATIO = 0.7;

const DAY_MS = 24 * 60 * 60 * 1000;

function isAlias(model: ChatModel): boolean {
  return model.id.startsWith("~");
}

/**
 * The model's id after the provider, split into words: "gpt-6-luna" is
 * ["gpt", "6", "luna"].
 */
function words(model: ChatModel): string[] {
  const name = model.id.slice(model.id.indexOf("/") + 1).split(":")[0] ?? "";
  return name.split("-");
}

/** A size ("72b", "a3b") tells models apart; a version or date doesn't. */
const SIZE = /^a?\d+(\.\d+)?[bmt]$/;

/**
 * The model's line without its versions and dates: "claude-sonnet" for both
 * "anthropic/claude-sonnet-4.5" and "anthropic/claude-3.5-sonnet", "gpt-luna"
 * for "openai/gpt-6-luna", but "qwen-72b-instruct" and "qwen-7b-instruct"
 * apart.
 */
function family(model: ChatModel): string {
  return words(model)
    .filter(
      (word) => SIZE.test(word) || (!/^\d/.test(word) && word !== "preview"),
    )
    .join("-");
}

const UNSTABLE = new Set(["preview", "exp", "experimental", "beta", "alpha"]);

/** Previews and experiments, which tend to vanish. */
function isUnstable(model: ChatModel): boolean {
  return words(model).some((word) => UNSTABLE.has(word));
}

const SPECIALIZED = new Set([
  "codex",
  "coder",
  "image",
  "audio",
  "search",
  "guard",
  "safeguard",
  "ocr",
]);

/** Made for one job, so no stand-in for a general model. */
function isSpecialized(model: ChatModel): boolean {
  return words(model).some((word) => SPECIALIZED.has(word));
}

/** Cheaper first, for a tie between two replacements. */
function cheaper(a: ChatModel, b: ChatModel): boolean {
  return (
    !!a.pricing &&
    !!b.pricing &&
    blendedPrice(a.pricing) < blendedPrice(b.pricing)
  );
}

/**
 * Whether `newer` replaces `older`: released at least SAME_LAUNCH_DAYS later,
 * costing no more for input or output, and doing everything `older` does.
 * Newer at the same price is taken to be better, unless it's a preview
 * replacing a release. From another family it must also cost about the
 * same, or a cheap new small model would archive last season's flagship,
 * and be a general model rather than one made for code or images.
 */
function replaces(newer: ChatModel, older: ChatModel): boolean {
  if (
    !newer.pricing ||
    !older.pricing ||
    !newer.released ||
    !older.released ||
    isAlias(newer) ||
    // Free variants are rate-limited and come and go.
    newer.id.endsWith(":free") ||
    (isUnstable(newer) && !isUnstable(older))
  )
    return false;
  if (
    Date.parse(newer.released) - Date.parse(older.released) <
    SAME_LAUNCH_DAYS * DAY_MS
  )
    return false;
  if (
    newer.pricing.inputPerMillionTokens > older.pricing.inputPerMillionTokens ||
    newer.pricing.outputPerMillionTokens > older.pricing.outputPerMillionTokens
  )
    return false;
  if (older.acceptsImages && !newer.acceptsImages) return false;
  if (
    older.contextTokens !== null &&
    (newer.contextTokens ?? 0) < older.contextTokens
  )
    return false;
  if (family(newer) === family(older)) return true;
  return (
    !isSpecialized(newer) &&
    blendedPrice(newer.pricing) >=
      RENAMED_TIER_PRICE_RATIO * blendedPrice(older.pricing)
  );
}

/**
 * The models a newer one from the same provider replaces, each with the
 * current model that replaces it: the newest of its own family if there is
 * one, else the newest of any, the cheaper of two released together. Aliases, models without a price and models without a date
 * are never archived.
 */
export function archivedModels(
  models: readonly ChatModel[],
): Map<string, ChatModel> {
  const byProvider = new Map<string, ChatModel[]>();
  for (const model of models) {
    const { provider } = describeModel(model);
    const list = byProvider.get(provider) ?? [];
    list.push(model);
    byProvider.set(provider, list);
  }

  const archived = new Map<string, ChatModel>();
  for (const list of byProvider.values()) {
    for (const older of list) {
      if (isAlias(older)) continue;
      let best: ChatModel | null = null;
      for (const newer of list) {
        if (!replaces(newer, older)) continue;
        if (!best) {
          best = newer;
          continue;
        }
        const ownFamily = family(newer) === family(older);
        const bestOwnFamily = family(best) === family(older);
        if (
          (ownFamily && !bestOwnFamily) ||
          (ownFamily === bestOwnFamily &&
            ((newer.released ?? "") > (best.released ?? "") ||
              (newer.released === best.released && cheaper(newer, best))))
        )
          best = newer;
      }
      if (best) archived.set(older.id, best);
    }
  }

  // Point past a replacement that is archived itself. Each step is to a
  // newer model, so this ends.
  for (const [id, replacement] of archived) {
    let current = replacement;
    for (
      let next = archived.get(current.id);
      next;
      next = archived.get(current.id)
    )
      current = next;
    archived.set(id, current);
  }
  return archived;
}
