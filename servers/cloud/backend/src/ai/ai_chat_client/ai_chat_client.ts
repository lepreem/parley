import { getEnv } from "../../env";
import { OpenRouter } from "@openrouter/sdk";

import { CACHE_KEYS, memory } from "../../memory";
import type {
  InputImage,
  InputText,
  OpenResponsesResult,
  OutputItems,
  ReasoningEffort,
  ResponsesRequest,
  Usage,
} from "@openrouter/sdk/models";
import { withTimeout } from "@parley/server-kit/runtime/withTimeout";
import type { ChatModel } from "@parley/contract";
import { guestModelsOf, offeredModels } from "./model_catalog";

const client = new OpenRouter({
  apiKey: getEnv().OPENROUTER_API_KEY,
  // The load test's stand-in; unset, the SDK uses OpenRouter itself.
  serverURL: getEnv().OPENROUTER_BASE_URL,
});

/**
 * Guests' turns go through a key of their own, whose credit limit is the cap
 * on what guests can spend. There is no guest client without that key, so a
 * guest turn can never fall back to the main one.
 */
const guestApiKey = getEnv().OPENROUTER_GUEST_API_KEY;
const guestClient =
  guestApiKey === undefined
    ? undefined
    : new OpenRouter({
        apiKey: guestApiKey,
        serverURL: getEnv().OPENROUTER_BASE_URL,
      });

function clientFor(guest: boolean) {
  if (!guest) return client;
  if (!guestClient) throw new Error("Guest chat isn't enabled");
  return guestClient;
}

/** Startup health check: fails if OpenRouter is unreachable or rejects the API key. */
async function ping(): Promise<void> {
  await client.models.list();
}

export type ChatTurn = {
  role: "user" | "assistant";
  content: string | (InputText | InputImage)[];
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
      { type: "input_text", text: content },
      ...imageUrls.map((imageUrl) => ({
        type: "input_image" as const,
        detail: "auto" as const,
        imageUrl,
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
// Reasoning models can think for minutes before their first token: tens of
// thousands of tokens, at around 100 a second, with room left to write a reply.
const CHAT_FIRST_TOKEN_TIMEOUT_MS = 6 * 60 * 1000; // 6 minutes
const CHAT_BETWEEN_CHUNKS_TIMEOUT_MS = 30 * 1000; // 30 seconds
// A model can stop partway through a reply to search and read what it finds.
const CHAT_BETWEEN_CHUNKS_ON_THE_WEB_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const TITLE_TIMEOUT_MS = 15 * 1000; // 15 seconds

/**
 * The most one turn can spend on the web, whichever model runs it. Exa charges
 * by the search, $0.007 for up to 10 results, and the page, $0.001, and honours
 * these limits for every model, where a provider's own tools mostly ignore
 * them. The larger cost is the tokens of the pages read: a full one is about
 * $0.024 at $3 per million.
 */
const WEB_TOOLS: NonNullable<ResponsesRequest["tools"]> = [
  {
    type: "openrouter:web_search",
    parameters: {
      engine: "exa",
      maxUses: 3,
      maxResults: 3,
      maxTotalResults: 9,
      maxCharacters: 4_000,
    },
  },
  {
    type: "openrouter:web_fetch",
    parameters: {
      engine: "exa",
      // A failed try counts, and models try other addresses for a blocked page.
      maxUses: 5,
      maxContentTokens: 8_000,
    },
  },
];

/**
 * Without this, models were seen to answer from memory about a page they had
 * just failed to open, and to date their answers by their training data.
 */
function webInstructions() {
  const today = new Date().toISOString().slice(0, 10);
  return `Today is ${today}. You can search the web and open web pages. If you can't open a page you were asked about, say so plainly, and don't describe what it says from memory as if you had read it. If you read a copy of a page on another site instead of the original, name the site you read it on.`;
}

/** The model reached its token ceiling while thinking, so it wrote nothing. */
export class NoRoomToReply extends Error {
  constructor() {
    super(
      "The model used up its token limit thinking and wrote no reply. Try a lower effort, or another model.",
    );
    this.name = "NoRoomToReply";
  }
}

/** Everything the model wrote, across the messages of a response. */
function replyText(response: OpenResponsesResult) {
  return response.output
    .flatMap((item) => (item.type === "message" ? item.content : []))
    .flatMap((part) => (part.type === "output_text" ? [part.text] : []))
    .join("");
}

async function nonStreamChatAI(
  sender: OpenRouter,
  responsesRequest: ResponsesRequest,
  abortSignal: AbortSignal,
) {
  const response = await sender.beta.responses.send(
    { responsesRequest: { ...responsesRequest, stream: false } },
    { signal: abortSignal },
  );

  if (!("output" in response))
    throw new Error("Expected a non-streaming chat response");

  return replyText(response);
}

/** What a finished part of a response says about the pages behind the reply. */
function readPages(
  item: OutputItems,
  { onSource, onUnreadPage }: Pick<ChatOptions, "onSource" | "onUnreadPage">,
) {
  if (item.type === "openrouter:web_fetch") {
    if (item.status === "completed" && !item.error) {
      onSource?.(item.url, item.title);
    } else {
      onUnreadPage?.(item.url, item.error);
    }
    return;
  }
  if (item.type !== "message") return;
  for (const part of item.content) {
    if (part.type !== "output_text") continue;
    for (const annotation of part.annotations ?? []) {
      if (annotation.type === "url_citation") {
        onSource?.(annotation.url, annotation.title);
      }
    }
  }
}

async function streamChatAI(
  sender: OpenRouter,
  responsesRequest: ResponsesRequest,
  onDelta: (delta: string) => void | Promise<void>,
  opts: Pick<ChatOptions, "onUsage" | "onSource" | "onUnreadPage">,
  {
    abortSignal,
    markProgress,
  }: { abortSignal: AbortSignal; markProgress: () => void },
) {
  const stream = await sender.beta.responses.send(
    { responsesRequest: { ...responsesRequest, stream: true } },
    { signal: abortSignal },
  );

  if (!(Symbol.asyncIterator in stream))
    throw new Error("Expected a streaming chat response");

  let full = "";
  let reachedCeiling = false;

  for await (const event of stream) {
    switch (event.type) {
      case "error":
        throw new Error(event.message);
      case "response.failed":
        throw new Error(event.response.error?.message ?? "The model failed");
      case "response.output_text.delta":
        // Only text counts: a stream can open with an empty chunk and then
        // think silently for longer than the between-chunk limit.
        if (event.delta) {
          markProgress();
          full += event.delta;
          await onDelta(event.delta);
        }
        break;
      case "response.output_item.done":
        readPages(event.item, opts);
        break;
      case "response.incomplete":
        reachedCeiling =
          event.response.incompleteDetails?.reason === "max_output_tokens";
        if (event.response.usage) opts.onUsage?.(event.response.usage);
        break;
      case "response.completed":
        if (event.response.usage) opts.onUsage?.(event.response.usage);
        break;
    }
  }

  if (reachedCeiling && !full) throw new NoRoomToReply();
  return full;
}

type ChatOptions = {
  onDelta?: ((delta: string) => void | Promise<void>) | undefined;
  /**
   * What a streamed call spent, as the provider reports it. The report comes
   * after the last of the reply, so a call stopped early never gets one.
   */
  onUsage?: ((usage: Usage) => void) | undefined;
  /** Ceiling on the completion, so one call can't run up an unbounded bill. */
  maxOutputTokens?: number | undefined;
  /**
   * How hard a reasoning model thinks. Its thinking counts against
   * maxOutputTokens, so a small ceiling needs "none" or the reply is empty.
   */
  reasoningEffort?: ReasoningEffort | undefined;
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
  /** Bills the call to the guest key. */
  guest?: boolean | undefined;
  /** Lets the model search the web and open pages, if it decides it needs to. */
  webSearch?: boolean | undefined;
  /** Each page the model found or read, as OpenRouter describes it. */
  onSource?: ((url: unknown, title: unknown) => void) | undefined;
  /** Each page the model tried to open and couldn't. */
  onUnreadPage?: ((url: unknown, error: unknown) => void) | undefined;
};

/**
 * Claude caches a prompt only when asked. Asking makes the first turn of a chat
 * about a quarter dearer (writing the cache) and each reply within 5 minutes of
 * the last about 15x cheaper (reading it); every read restarts the 5 minutes.
 * Other providers cache on their own, so they're left alone.
 */
function cachesOnRequest(model: string): boolean {
  return model.replace(/^~/, "").startsWith("anthropic/");
}

async function complete(
  model: string,
  messages: ChatTurn[],
  opts: ChatOptions = {},
): Promise<string> {
  const responsesRequest: ResponsesRequest = {
    model,
    input: messages,
    instructions: opts.webSearch ? webInstructions() : undefined,
    maxOutputTokens: opts.maxOutputTokens,
    reasoning: opts.reasoningEffort
      ? { effort: opts.reasoningEffort }
      : undefined,
    // `sort: "latency"` routes to the lowest time-to-first-token endpoint (no
    // load balancing); paired with the sticky sessionId, turns stay on one fast,
    // warm provider.
    provider: { sort: "latency" },
    sessionId: opts.sessionId,
    tools: opts.webSearch ? WEB_TOOLS : undefined,
    cacheControl: cachesOnRequest(model) ? { type: "ephemeral" } : undefined,
  };

  const timeoutOptions = {
    timeoutMs: opts.timeoutMs ?? CHAT_TOTAL_TIMEOUT_MS,
    firstProgressTimeoutMs: opts.onDelta
      ? CHAT_FIRST_TOKEN_TIMEOUT_MS
      : undefined,
    progressTimeoutMs: opts.onDelta
      ? opts.webSearch
        ? CHAT_BETWEEN_CHUNKS_ON_THE_WEB_TIMEOUT_MS
        : CHAT_BETWEEN_CHUNKS_TIMEOUT_MS
      : undefined,
    signal: opts.signal,
  };

  const sender = clientFor(opts.guest ?? false);
  return withTimeout(timeoutOptions, (ctx) =>
    opts.onDelta
      ? streamChatAI(sender, responsesRequest, opts.onDelta, opts, ctx)
      : nonStreamChatAI(sender, responsesRequest, ctx.abortSignal),
  );
}

async function fetchChatModels(): Promise<ChatModel[]> {
  // Only models that answer in text: every one listed is a chat model.
  // Transcription is served by Deepgram.
  const { data } = (await client.models.list({ outputModalities: "text" }))
    .result;
  return offeredModels(data);
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

/** The models a guest can chat with. */
async function listGuestModels(): Promise<ChatModel[]> {
  return guestModelsOf(await listModels());
}

async function isGuestModel(id: string): Promise<boolean> {
  return (await listGuestModels()).some((model) => model.id === id);
}

const MAX_TITLE_INPUT_CHARS = 12_000;
// The alias follows OpenAI's newest Luna.
const DEFAULT_TITLE_GENERATION_MODEL = "~openai/gpt-luna-latest";

async function generateTitle(
  kind: "conversation" | "transcript",
  content: string,
  { guest = false }: { guest?: boolean } = {},
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
      guest,
    },
  );

  return title.trim();
}

/** Chat completions and the chat model catalog, from OpenRouter. */
export const chat = {
  complete,
  listModels,
  listGuestModels,
  findModel,
  isGuestModel,
  generateTitle,
  ping,
};
