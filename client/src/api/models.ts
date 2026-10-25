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
