import type {
  ChatModel,
  ChatModelsResponse,
  ModelPricing,
  ReasoningEffort,
} from "@parley/contract";
import { apiJson } from "./http";
import type { Server } from "./server";

export type { ChatModel, ChatModelsResponse, ModelPricing, ReasoningEffort };

export async function fetchChatModels(
  server: Server,
): Promise<ChatModelsResponse> {
  const data = await apiJson<ChatModelsResponse>(server, "/models/chat");
  if (!Array.isArray(data?.models)) throw new Error("Invalid models response");
  return data;
}

/** The model with this id or alias, if it's one of these. */
export function findChatModel(
  models: readonly ChatModel[],
  id: string,
): ChatModel | undefined {
  return models.find((model) => model.id === id || model.aliases.includes(id));
}

/** Fall back to the first available model when the preferred one isn't offered. */
export function resolveDefaultModel(
  modelIds: string[],
  preferredModelId: string | null,
): string | null {
  if (preferredModelId && modelIds.includes(preferredModelId))
    return preferredModelId;
  return modelIds[0] ?? null;
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
