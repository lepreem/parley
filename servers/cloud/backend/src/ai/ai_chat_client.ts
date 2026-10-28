import { getEnv } from "../env";
import { OpenRouter } from "@openrouter/sdk";

import { CACHE_KEYS, memory } from "../memory";
import type {
  ChatContentItems,
  ChatRequest,
  PublicPricing,
} from "@openrouter/sdk/models";
import { withTimeout } from "@parley/server-kit/runtime/withTimeout";
import type { ChatModel, ModelPricing } from "@parley/contract";

const client = new OpenRouter({
  apiKey: getEnv().OPENROUTER_API_KEY,
  // The load test's stand-in; unset, the SDK uses OpenRouter itself.
  serverURL: getEnv().OPENROUTER_BASE_URL,
});

/** Startup health check: fails if OpenRouter is unreachable or rejects the API key. */
async function ping(): Promise<void> {
  await client.models.list();
}

export type ChatTurn = {
  role: "user" | "assistant";
  content: string | ChatContentItems[];
};

/**
 * A user turn, as content parts when it carries images and as a plain string
 * otherwise — the array form costs nothing to send but is noise in every log
 * and test for the text-only turns that are the overwhelming majority.
 */
export function buildUserTurn(
  content: string,
  imageUrls: readonly string[] = [],
): ChatTurn {
  if (imageUrls.length === 0) return { role: "user", content };

  return {
    role: "user",
    content: [
      { type: "text", text: content },
      ...imageUrls.map((url) => ({
        type: "image_url" as const, // find more robust way, or find a way to unify "image_url"
        imageUrl: { url },
      })),
    ],
  };
}

// Nothing else ends a stalled model call: OpenRouter's keep-alive comments keep
// the connection open, and the SDK drops them before they reach us. Until the
// call ends, the handler holds the conversation claim and attachment
// reservations. The total stays under CLAIM_LEASE_MS (10 minutes) so the turn
// can still be persisted afterwards.
const CHAT_TOTAL_TIMEOUT_MS = 8 * 60 * 1000; // 8 minutes
// Reasoning models can think for minutes before their first token.
const CHAT_FIRST_TOKEN_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const CHAT_BETWEEN_CHUNKS_TIMEOUT_MS = 30 * 1000; // 30 seconds
const TITLE_TIMEOUT_MS = 15 * 1000; // 15 seconds

async function nonStreamChatAI(
  chatRequest: ChatRequest,
  abortSignal: AbortSignal,
) {
  const completion = await client.chat.send(
    { chatRequest },
    { signal: abortSignal },
  );

  if (!("choices" in completion))
    throw new Error("Expected a non-streaming chat response");

  const content = completion.choices[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

async function streamChatAI(
  chatRequest: ChatRequest,
  onDelta: (delta: string) => void | Promise<void>,
  {
    abortSignal,
    markProgress,
  }: { abortSignal: AbortSignal; markProgress: () => void },
) {
  const stream = await client.chat.send(
    { chatRequest: { ...chatRequest, stream: true } },
    { signal: abortSignal },
  );

  if (!(Symbol.asyncIterator in stream))
    throw new Error("Expected a streaming chat response");

  let full = "";

  for await (const chunk of stream) {
    if (chunk.error) throw new Error(chunk.error.message);

    const delta = chunk.choices[0]?.delta?.content;

    // Only text counts: a stream can open with an empty chunk and then think
    // silently for longer than the between-chunk limit.
    if (delta) {
      markProgress();
      full += delta;
      await onDelta(delta);
    }
  }

  return full;
}

type ChatOptions = {
  onDelta?: ((delta: string) => void | Promise<void>) | undefined;
  /** Ceiling on the completion, so one call can't run up an unbounded bill. */
  maxOutputTokens?: number | undefined;
  /**
   * Groups a conversation's turns so OpenRouter routes them all to the same
   * provider (sticky), keeping that provider's prompt cache warm across the
   * turn's stable history prefix — the biggest lever on time-to-first-token.
   */
  sessionId?: string | undefined;
  /** Ceiling on the whole call. Defaults to CHAT_TOTAL_TIMEOUT_MS. */
  timeoutMs?: number | undefined;
  /** Ends the call early: the stop button, through the reply registry. */
  signal?: AbortSignal | undefined;
};

async function complete(
  model: string,
  messages: ChatTurn[],
  opts: ChatOptions = {},
): Promise<string> {
  const chatRequest: ChatRequest = {
    model,
    messages,
    maxCompletionTokens: opts.maxOutputTokens,
    // `sort: "latency"` routes to the lowest time-to-first-token endpoint (no
    // load balancing); paired with the sticky sessionId, turns stay on one fast,
    // warm provider.
    provider: { sort: "latency" },
    sessionId: opts.sessionId,
  };

  const timeoutOptions = {
    timeoutMs: opts.timeoutMs ?? CHAT_TOTAL_TIMEOUT_MS,
    firstProgressTimeoutMs: opts.onDelta
      ? CHAT_FIRST_TOKEN_TIMEOUT_MS
      : undefined,
    progressTimeoutMs: opts.onDelta
      ? CHAT_BETWEEN_CHUNKS_TIMEOUT_MS
      : undefined,
    signal: opts.signal,
  };

  return withTimeout(timeoutOptions, (ctx) =>
    opts.onDelta
      ? streamChatAI(chatRequest, opts.onDelta, ctx)
      : nonStreamChatAI(chatRequest, ctx.abortSignal),
  );
}

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

async function fetchChatModels(): Promise<ChatModel[]> {
  // Only models that answer in text: every one listed is a chat model.
  // Transcription is served by Deepgram.
  const models = (await client.models.list({ outputModalities: "text" })).result
    .data;

  // ":batch" variants are for OpenRouter's batch API, which doesn't stream, so
  // none of them can hold a chat.
  return models
    .filter((model) => !model.id.endsWith(":batch"))
    .map((model) => ({
      id: model.id,
      name: model.name,
      contextTokens: model.contextLength,
      acceptsImages: model.architecture.inputModalities.includes("image"),
      pricing: toPricing(model.pricing),
    }));
}

// Every send looks up the chosen model here, so the cache keeps that lookup
// off the network. Serving it stale while it refreshes means no send waits on
// the catalog once a process has loaded it.
function listModels(): Promise<ChatModel[]> {
  return memory.modelLists.getOrSet(
    CACHE_KEYS.openRouterModels,
    fetchChatModels,
    {
      serveStale: true,
    },
  );
}

/**
 * The model with this id, or undefined when it isn't one the app can chat
 * with. Checked up front, so an unknown model or images for a text-only one
 * is a 400 on the request rather than a provider rejection mid-stream, where
 * the only channel left is an SSE error event.
 */
async function findModel(id: string): Promise<ChatModel | undefined> {
  return (await listModels()).find((model) => model.id === id);
}

const MAX_TITLE_INPUT_CHARS = 12_000;
const DEFAULT_TITLE_GENERATION_MODEL = "openai/gpt-4o-mini";

async function generateTitle(
  kind: "conversation" | "transcript",
  content: string,
): Promise<string> {
  const title = await complete(
    DEFAULT_TITLE_GENERATION_MODEL,
    [
      {
        role: "user",
        content: `Generate a concise, descriptive title of at most eight words for this ${kind}. Return only the title.\n\n${content.slice(0, MAX_TITLE_INPUT_CHARS)}`,
      },
    ],
    { maxOutputTokens: 24, timeoutMs: TITLE_TIMEOUT_MS },
  );

  return title.trim();
}

/** Chat completions and the chat model catalog, from OpenRouter. */
export const chat = {
  complete,
  listModels,
  findModel,
  generateTitle,
  ping,
};
