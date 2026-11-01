import type { Model, PublicPricing } from "@openrouter/sdk/models";
import type { ChatModel, ModelPricing } from "@parley/contract";

/**
 * Which of OpenRouter's models the app offers, and which of those it archives.
 * Everything that decides what reaches the model picker is here, private to
 * ai_chat_client.ts.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Models listed longer ago than this are left out. Intelligence keeps getting
 * cheaper, so a model this old is beaten for its price by a newer one, from
 * its own provider or another.
 */
const MAX_AGE_DAYS = 365;

/** Launches closer together than this are siblings, not one replacing another. */
const SAME_LAUNCH_DAYS = 14;

/**
 * How much cheaper a replacement from another family may be. Further below,
 * it's a smaller tier (Haiku, not a new Sonnet), not the same tier renamed
 * (GPT-4o mini to GPT-6 Luna).
 */
const RENAMED_TIER_PRICE_RATIO = 0.7;

/**
 * Guests get models that cost no more than this, for input and output both:
 * GPT-6 Luna's price. A price rather than a model, so guest chat doesn't end
 * when one model leaves the catalog. A model without a fixed price (a
 * router's) isn't one of them.
 */
const GUEST_PRICE_CEILING: ModelPricing = {
  inputPerMillionTokens: 0.1,
  outputPerMillionTokens: 0.5,
};

/* ------------------------------------------------------------------ prices */

/**
 * OpenRouter's per-token USD price as dollars per million tokens, rounded to
 * a millionth of a dollar to drop the float noise of scaling up. Null for a
 * price that isn't one: its routers list -1, since what they charge depends
 * on the model they pick.
 */
function perMillionTokens(perToken: string): number | null {
  const price = Number(perToken);
  if (!Number.isFinite(price) || price < 0) return null;
  return Math.round(price * 1e12) / 1e6;
}

function toPricing(pricing: PublicPricing): ModelPricing | null {
  const inputPerMillionTokens = perMillionTokens(pricing.prompt);
  const outputPerMillionTokens = perMillionTokens(pricing.completion);
  if (inputPerMillionTokens === null || outputPerMillionTokens === null)
    return null;
  return { inputPerMillionTokens, outputPerMillionTokens };
}

/**
 * One price per model to compare by: three input tokens to every output one,
 * as the client's price tiers weigh it. A turn here replays history and
 * transcripts, so it reads far more than the model writes.
 */
function blendedPrice(pricing: ModelPricing): number {
  return (
    (3 * pricing.inputPerMillionTokens + pricing.outputPerMillionTokens) / 4
  );
}

/* ---------------------------------------------------------------- offering */

/**
 * OpenAI's "-pro" ids are the model beside them run in its pro reasoning
 * mode, which thinks far longer at the same per-token price. ChatGPT's own
 * default is the plain one, so that is the one offered. Other providers'
 * "-pro" models are models of their own (Perplexity's Sonar Pro).
 */
function isOpenAIProMode(id: string, ids: ReadonlySet<string>): boolean {
  return (
    id.startsWith("openai/") && id.endsWith("-pro") && ids.has(id.slice(0, -4))
  );
}

/**
 * The models OpenRouter lists that the app offers, each with the aliases
 * that name it and, when it's archived, why.
 *
 * Left out: ":batch" variants, which are for OpenRouter's batch API and don't
 * stream, so none can hold a chat; aliases ("~…-latest"), which become their
 * target's `aliases` rather than a second listing; OpenAI's pro modes; and
 * models older than MAX_AGE_DAYS. The age is judged here rather than asked of
 * OpenRouter (its maxAgeDays), which would drop an alias made long ago and
 * with it the name config knows its model by.
 */
export function offeredModels(
  models: readonly Model[],
  now: number = Date.now(),
): ChatModel[] {
  const ids = new Set(models.map((model) => model.id));
  const aliases = new Map<string, string[]>();
  for (const model of models) {
    if (!model.aliasTarget) continue;
    const list = aliases.get(model.aliasTarget.slug) ?? [];
    list.push(model.id);
    aliases.set(model.aliasTarget.slug, list);
  }

  const oldest = now - MAX_AGE_DAYS * DAY_MS;
  const offered = models
    .filter(
      (model) =>
        !model.id.endsWith(":batch") &&
        !model.aliasTarget &&
        !isOpenAIProMode(model.id, ids) &&
        model.created * 1000 >= oldest,
    )
    .map((model): ChatModel => ({
      id: model.id,
      name: model.name,
      contextTokens: model.contextLength,
      acceptsImages: model.architecture.inputModalities.includes("image"),
      released: new Date(model.created * 1000).toISOString().slice(0, 10),
      aliases: aliases.get(model.id) ?? [],
      pricing: toPricing(model.pricing),
      replacedBy: null,
      retires: model.expirationDate ?? null,
    }));

  const replacements = replacementsOf(offered);
  return offered.map((model) => ({
    ...model,
    replacedBy: replacements.get(model.id)?.id ?? null,
  }));
}

/** The models a guest can chat with. */
export function guestModelsOf(models: readonly ChatModel[]): ChatModel[] {
  return models.filter(
    ({ pricing }) =>
      pricing !== null &&
      pricing.inputPerMillionTokens <=
        GUEST_PRICE_CEILING.inputPerMillionTokens &&
      pricing.outputPerMillionTokens <=
        GUEST_PRICE_CEILING.outputPerMillionTokens,
  );
}

/* ----------------------------------------------------------------- archive */

/**
 * The model's provider as OpenRouter names it ("Anthropic: Claude Opus 5.5"),
 * which one provider's several id prefixes ("meta", "meta-llama") share.
 */
function providerOf(model: ChatModel): string {
  const separator = model.name.indexOf(": ");
  return separator > 0
    ? model.name.slice(0, separator)
    : (model.id.split("/")[0] ?? model.id);
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
 * one, else the newest of any, the cheaper of two released together.
 * Models without a price or a date are never archived.
 */
function replacementsOf(models: readonly ChatModel[]): Map<string, ChatModel> {
  const byProvider = new Map<string, ChatModel[]>();
  for (const model of models) {
    const provider = providerOf(model);
    const list = byProvider.get(provider) ?? [];
    list.push(model);
    byProvider.set(provider, list);
  }

  const replacements = new Map<string, ChatModel>();
  for (const list of byProvider.values()) {
    for (const older of list) {
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
      if (best) replacements.set(older.id, best);
    }
  }

  // Point past a replacement that is replaced itself. Each step is to a
  // newer model, so this ends.
  for (const [id, replacement] of replacements) {
    let current = replacement;
    for (
      let next = replacements.get(current.id);
      next;
      next = replacements.get(current.id)
    )
      current = next;
    replacements.set(id, current);
  }
  return replacements;
}
