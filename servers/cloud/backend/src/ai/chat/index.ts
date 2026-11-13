/**
 * Chat completions and the chat model catalog, from OpenRouter: `chat.<what>`.
 *
 * The files beside this one don't import each other; anything that needs two
 * of them is put together here.
 */

import type { ChatModel } from "@parley/contract";
import {
  allowsModelPrice,
  CAPABILITIES,
  type Tier,
} from "@parley/contract/tiers";
import * as memory from "../../memory";
import * as completion from "./completion";
import { offeredModels } from "./model_catalog";
import * as openRouter from "./openRouter";

export { ping } from "./openRouter";
export { buildUserTurn, NoRoomToReply, type ChatTurn } from "./completion";
export { defaultModelId, recommendedModelIds } from "./model_catalog";

/* -------------------------------------------------------------- completions */

/**
 * The model's reply, billed to the key of the caller's tier. Streamed to
 * onDelta when it's given.
 */
export function complete(
  model: string,
  messages: completion.ChatTurn[],
  {
    tier,
    ...opts
  }: completion.ChatOptions & {
    /** Whose call it is, which picks the key it's billed to. */
    tier: Tier;
  },
): Promise<string> {
  return completion.complete(openRouter.clientFor(tier), model, messages, opts);
}

const MAX_TITLE_INPUT_CHARS = 12_000;
// The alias follows OpenAI's newest Luna.
const DEFAULT_TITLE_GENERATION_MODEL = "~openai/gpt-luna-latest";
const TITLE_TIMEOUT_MS = 15 * 1000; // 15 seconds

export async function generateTitle(
  kind: "conversation" | "transcript",
  content: string,
  { tier }: { tier: Tier },
): Promise<string> {
  const title = await complete(
    DEFAULT_TITLE_GENERATION_MODEL,
    [
      {
        role: "user",
        content: `Generate a concise, descriptive title of at most eight words for this ${kind}. Return only the title.\n\n${content.slice(0, MAX_TITLE_INPUT_CHARS)}`,
      },
    ],
    {
      maxOutputTokens: 24,
      reasoningEffort: "none",
      timeoutMs: TITLE_TIMEOUT_MS,
      tier,
    },
  );

  return title.trim();
}

/* -------------------------------------------------------------------- models */

// Every send looks up the chosen model here, so the cache keeps that lookup
// off the network. Serving it stale while it refreshes means no send waits on
// the catalog once a process has loaded it.
export function listModels(): Promise<ChatModel[]> {
  return memory.modelLists.getOrSet(
    memory.modelLists.CACHE_KEYS.openRouterModels,
    async () => offeredModels(await openRouter.listTextModels()),
    { serveStale: true },
  );
}

/**
 * The model with this id, or undefined when it isn't one the app can chat
 * with. Checked up front, so an unknown model or images for a text-only one
 * is a 400 on the request rather than a provider rejection mid-stream, where
 * the only channel left is an SSE error event.
 */
export async function findModel(id: string): Promise<ChatModel | undefined> {
  return (await listModels()).find((model) => model.id === id);
}

/** The models this tier can chat with. */
export async function listModelsFor(tier: Tier): Promise<ChatModel[]> {
  const capabilities = CAPABILITIES[tier];
  return (await listModels()).filter((model) =>
    allowsModelPrice(capabilities, model.pricing),
  );
}

export async function offersModelTo(tier: Tier, id: string): Promise<boolean> {
  return (await listModelsFor(tier)).some((model) => model.id === id);
}
