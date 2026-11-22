/** One chat call to OpenRouter: the request, streamed or not, under time limits. */

import type { OpenRouter } from "@openrouter/sdk";
import type {
  InputImage,
  InputsUnion1,
  InputText,
  OpenResponsesResult,
  OutputItems,
  ReasoningEffort,
  ResponsesRequest,
  Usage,
} from "@openrouter/sdk/models";
import { withTimeout } from "@parley/server-kit/runtime/withTimeout";

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
 * How many times one turn goes back to the model with what its tools
 * answered. A model that hasn't answered by then is going round in circles.
 */
const MAX_TOOL_ROUNDS = 8;

/** A tool of Parley's own: its parameters are a JSON Schema object. */
type FunctionToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** Parley's own tools a turn offers the model, and how to run a call. */
export type FunctionTools = {
  definitions: FunctionToolDefinition[];
  /** What the model is told about acting with them. */
  instructions: string;
  /** Runs one call; what it answers is what the model reads back. */
  run: (
    name: string,
    rawArguments: string,
    signal?: AbortSignal,
  ) => Promise<string>;
};

/** The model kept calling tools and never answered. */
class TooManyToolRounds extends Error {
  constructor() {
    super(`The model called tools ${MAX_TOOL_ROUNDS} times without answering`);
    this.name = "TooManyToolRounds";
  }
}

/**
 * Without this, models were seen to answer from memory about a page they had
 * just failed to open, and to date their answers by their training data.
 */
function webInstructions() {
  const today = new Date().toISOString().slice(0, 10);
  return `Today is ${today}. You can search the web and open web pages. If you can't open a page you were asked about, say so plainly, and don't describe what it says from memory as if you had read it. If you read a copy of a page on another site instead of the original, name the site you read it on.`;
}

/**
 * The caller's instructions first, then the tools': they stay the same from
 * turn to turn, so they sit in the cached prefix ahead of the web ones, which
 * carry the date.
 */
function joinInstructions(...parts: (string | undefined)[]) {
  const given = parts.filter(
    (part) => part !== undefined && part.trim() !== "",
  );
  return given.length > 0 ? given.join("\n\n") : undefined;
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

/** What one call to the model came back with. */
type Round = {
  text: string;
  /** Tool calls for us to run, in the order the model made them. */
  calls: { callId: string; name: string; arguments: string }[];
  /**
   * What the model did this round, as the next round's input takes it: its
   * thinking, what it wrote and its calls, so it picks up where it left off.
   */
  replay: InputsUnion1[];
  reachedCeiling: boolean;
};

/**
 * An output item as the next request's input. Server tools' items (the web)
 * aren't carried: their results are in what the model wrote.
 */
function replayOf(item: OutputItems): InputsUnion1 | undefined {
  switch (item.type) {
    case "reasoning":
      return {
        type: "reasoning",
        id: item.id,
        summary: item.summary,
        encryptedContent: item.encryptedContent ?? null,
        ...(item.content ? { content: item.content } : {}),
      };
    case "function_call":
      return {
        type: "function_call",
        callId: item.callId,
        name: item.name,
        arguments: item.arguments,
        ...(item.id ? { id: item.id } : {}),
      };
    case "message": {
      const text = item.content
        .flatMap((part) => (part.type === "output_text" ? [part.text] : []))
        .join("");
      return text ? { role: "assistant", content: text } : undefined;
    }
    default:
      return undefined;
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
): Promise<Round> {
  const stream = await sender.beta.responses.send(
    { responsesRequest: { ...responsesRequest, stream: true } },
    { signal: abortSignal },
  );

  if (!(Symbol.asyncIterator in stream))
    throw new Error("Expected a streaming chat response");

  const round: Round = {
    text: "",
    calls: [],
    replay: [],
    reachedCeiling: false,
  };

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
          round.text += event.delta;
          await onDelta(event.delta);
        }
        break;
      case "response.output_item.done": {
        readPages(event.item, opts);
        const replay = replayOf(event.item);
        if (replay) round.replay.push(replay);
        if (event.item.type === "function_call") {
          // A call is progress as much as text is.
          markProgress();
          round.calls.push({
            callId: event.item.callId,
            name: event.item.name,
            arguments: event.item.arguments,
          });
        }
        break;
      }
      case "response.incomplete":
        round.reachedCeiling =
          event.response.incompleteDetails?.reason === "max_output_tokens";
        if (event.response.usage) opts.onUsage?.(event.response.usage);
        break;
      case "response.completed":
        if (event.response.usage) opts.onUsage?.(event.response.usage);
        break;
    }
  }

  return round;
}

/**
 * The reply, going back to the model with what `tools` answered for as long
 * as it calls them. Each round's text streams to onDelta as it comes, a blank
 * line apart from the round before.
 */
async function streamReply(
  sender: OpenRouter,
  responsesRequest: ResponsesRequest & { input: InputsUnion1[] },
  onDelta: (delta: string) => void | Promise<void>,
  tools: FunctionTools | undefined,
  opts: Pick<ChatOptions, "onUsage" | "onSource" | "onUnreadPage">,
  ctx: { abortSignal: AbortSignal; markProgress: () => void },
): Promise<string> {
  let input = responsesRequest.input;
  let full = "";

  for (let roundNumber = 0; roundNumber < MAX_TOOL_ROUNDS; roundNumber++) {
    let roundStarted = false;
    const round = await streamChatAI(
      sender,
      { ...responsesRequest, input },
      async (delta) => {
        if (!roundStarted && full && !full.endsWith("\n\n")) {
          const gap = full.endsWith("\n") ? "\n" : "\n\n";
          full += gap;
          await onDelta(gap);
        }
        roundStarted = true;
        full += delta;
        await onDelta(delta);
      },
      opts,
      ctx,
    );

    if (round.calls.length === 0 || !tools) {
      if (round.reachedCeiling && !full) throw new NoRoomToReply();
      return full;
    }

    const outputs = [];
    // One at a time, in the order the model made them: a later call can
    // depend on an earlier one, such as making a project then moving a chat
    // into it.
    for (const call of round.calls) {
      const output = await tools.run(
        call.name,
        call.arguments,
        ctx.abortSignal,
      );
      outputs.push({
        type: "function_call_output" as const,
        callId: call.callId,
        output,
      });
      ctx.markProgress();
    }
    input = [...input, ...round.replay, ...outputs];
  }
  throw new TooManyToolRounds();
}

export type ChatOptions = {
  /** What the model is told before the conversation: a project's instructions. */
  instructions?: string | undefined;
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
  /** Lets the model search the web and open pages, if it decides it needs to. */
  webSearch?: boolean | undefined;
  /** Each page the model found or read, as OpenRouter describes it. */
  onSource?: ((url: unknown, title: unknown) => void) | undefined;
  /** Each page the model tried to open and couldn't. */
  onUnreadPage?: ((url: unknown, error: unknown) => void) | undefined;
  /**
   * Parley's own tools the model may call. Only a streamed call offers them,
   * which a chat turn always is.
   */
  tools?: FunctionTools | undefined;
};

/** The web's tools and Parley's own, whichever the call has. */
function toolsOf(
  webSearch: boolean,
  functionTools: FunctionTools | undefined,
): ResponsesRequest["tools"] {
  const tools = [
    ...(webSearch ? WEB_TOOLS : []),
    ...(functionTools?.definitions ?? []).map((definition) => ({
      type: "function" as const,
      ...definition,
    })),
  ];
  return tools.length > 0 ? tools : undefined;
}

/** The reply, sent through `sender`: streamed to onDelta when it's given. */
export async function complete(
  sender: OpenRouter,
  model: string,
  messages: ChatTurn[],
  opts: ChatOptions,
): Promise<string> {
  const { onDelta } = opts;
  // Running a call needs the next round, which only the streamed loop makes.
  const functionTools = onDelta ? opts.tools : undefined;
  const responsesRequest = {
    model,
    input: messages,
    instructions: joinInstructions(
      opts.instructions,
      functionTools?.instructions,
      opts.webSearch ? webInstructions() : undefined,
    ),
    maxOutputTokens: opts.maxOutputTokens,
    reasoning: opts.reasoningEffort
      ? { effort: opts.reasoningEffort }
      : undefined,
    // `sort: "latency"` routes to the lowest time-to-first-token endpoint (no
    // load balancing); paired with the sticky sessionId, turns stay on one fast,
    // warm provider.
    provider: { sort: "latency" },
    sessionId: opts.sessionId,
    tools: toolsOf(opts.webSearch ?? false, functionTools),
    // Claude caches a prompt only when asked: the first turn of a chat costs
    // about a quarter more (writing the cache) and each reply within 5 minutes
    // of the last about 15x less (reading it). Other models cache on their own
    // and ignore this; measured 2026-11-10 on GPT, Gemini and DeepSeek, it
    // changed neither their cost nor their cache hits.
    cacheControl: { type: "ephemeral" },
  } satisfies ResponsesRequest;

  const timeoutOptions = {
    timeoutMs: opts.timeoutMs ?? CHAT_TOTAL_TIMEOUT_MS,
    firstProgressTimeoutMs: onDelta ? CHAT_FIRST_TOKEN_TIMEOUT_MS : undefined,
    progressTimeoutMs: onDelta
      ? opts.webSearch || functionTools
        ? CHAT_BETWEEN_CHUNKS_ON_THE_WEB_TIMEOUT_MS
        : CHAT_BETWEEN_CHUNKS_TIMEOUT_MS
      : undefined,
    signal: opts.signal,
  };

  return withTimeout(timeoutOptions, (ctx) =>
    onDelta
      ? streamReply(sender, responsesRequest, onDelta, functionTools, opts, ctx)
      : nonStreamChatAI(sender, responsesRequest, ctx.abortSignal),
  );
}
