import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CACHE_KEYS } from "../../src/memory/modelLists";
import { CLAIM_LEASE_MS } from "../../src/data/conversations.data";

const { mockGetOrSetCache, mockModelsList, mockResponsesSend, sentWithKeys } =
  vi.hoisted(() => ({
    mockGetOrSetCache: vi.fn(),
    mockModelsList: vi.fn(),
    mockResponsesSend: vi.fn(),
    /** The API key of the client each chat request went through. */
    sentWithKeys: [] as string[],
  }));

vi.mock("../../src/memory/modelLists", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/memory/modelLists")>()),
  modelLists: { getOrSet: mockGetOrSetCache },
}));

/** Caching itself is covered in modelLists.test.ts; here the fetch always runs. */
const runFetch = <T>(_name: unknown, fetch: () => Promise<T>) => fetch();

vi.mock("@openrouter/sdk", () => ({
  OpenRouter: class {
    constructor(private readonly options: { apiKey: string }) {}
    models = { list: mockModelsList };
    beta = {
      responses: {
        send: (...args: unknown[]) => {
          sentWithKeys.push(this.options.apiKey);
          return mockResponsesSend(...args);
        },
      },
    };
  },
}));

import {
  buildUserTurn,
  chat,
  NoRoomToReply,
} from "../../src/ai/ai_chat_client/ai_chat_client";

const MODEL_ID = "openai/gpt-4o-mini";

/** A whole response, as a call that doesn't stream gets it. */
const responseOf = (text: string) => ({
  output: [{ type: "message", content: [{ type: "output_text", text }] }],
});

const textDelta = (delta: string) => ({
  type: "response.output_text.delta",
  delta,
});

// How the app describes the OpenRouter model below: only what it uses.
const sampleModel = {
  id: MODEL_ID,
  name: "GPT-4o Mini",
  contextTokens: 128000,
  maxOutputTokens: null,
  acceptsImages: true,
  released: "2024-07-18",
  aliases: [],
  replacedBy: null,
  retires: null,
  pricing: { inputPerMillionTokens: 0.15, outputPerMillionTokens: 0.6 },
  reasoning: null,
  searchesWeb: false,
};

const openRouterListModel = {
  id: MODEL_ID,
  name: "GPT-4o Mini",
  description: "Fast chat model",
  created: 1721260800,
  contextLength: 128000,
  knowledgeCutoff: null,
  topProvider: { contextLength: 128000, isModerated: true },
  pricing: { prompt: "0.00000015", completion: "0.0000006" },
  supportedParameters: ["temperature", "max_tokens"],
  architecture: {
    outputModalities: ["text"],
    inputModalities: ["text", "image"],
    modality: "text",
  },
};

describe("listChatModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The fixtures are from 2024; the catalog leaves out models a year old.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-08-01"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves the catalog through its cache entry", async () => {
    mockGetOrSetCache.mockResolvedValueOnce([sampleModel]);

    expect(await chat.listModels()).toEqual([sampleModel]);
    expect(mockGetOrSetCache).toHaveBeenCalledWith(
      CACHE_KEYS.openRouterModels,
      expect.any(Function),
      { serveStale: true },
    );
    expect(mockModelsList).not.toHaveBeenCalled();
  });

  it("describes what OpenRouter lists in the app's own terms", async () => {
    mockGetOrSetCache.mockImplementationOnce(runFetch);
    mockModelsList.mockResolvedValueOnce({
      result: {
        data: [
          openRouterListModel,
          {
            ...openRouterListModel,
            id: "vendor/text-only",
            name: "Text only",
            contextLength: null,
            architecture: {
              ...openRouterListModel.architecture,
              inputModalities: ["text"],
            },
          },
          // A router: what it charges depends on the model it picks.
          {
            ...openRouterListModel,
            id: "openrouter/auto",
            name: "Auto Router",
            pricing: { prompt: "-1", completion: "-1" },
          },
        ],
      },
    });

    expect(await chat.listModels()).toEqual([
      sampleModel,
      {
        id: "vendor/text-only",
        name: "Text only",
        contextTokens: null,
        maxOutputTokens: null,
        acceptsImages: false,
        released: "2024-07-18",
        aliases: [],
        replacedBy: null,
        retires: null,
        pricing: { inputPerMillionTokens: 0.15, outputPerMillionTokens: 0.6 },
        reasoning: null,
        searchesWeb: false,
      },
      {
        id: "openrouter/auto",
        name: "Auto Router",
        contextTokens: 128000,
        maxOutputTokens: null,
        acceptsImages: true,
        released: "2024-07-18",
        aliases: [],
        replacedBy: null,
        retires: null,
        pricing: null,
        reasoning: null,
        searchesWeb: false,
      },
    ]);
    // Only text-output models are relevant here; transcription is Deepgram's.
    expect(mockModelsList).toHaveBeenCalledWith({ outputModalities: "text" });
  });
});

describe("listGuestModels", () => {
  const priced = (id: string, input: number, output: number) => ({
    ...sampleModel,
    id,
    pricing: { inputPerMillionTokens: input, outputPerMillionTokens: output },
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers what costs no more than $0.10/$0.50, for input and output both", async () => {
    mockGetOrSetCache.mockResolvedValue([
      priced("at-ceiling/model", 0.1, 0.5),
      priced("cheap/model", 0.05, 0.2),
      priced("free/model:free", 0, 0),
      priced("dear-input/model", 0.15, 0.4),
      priced("dear-output/model", 0.05, 0.6),
      { ...sampleModel, id: "openrouter/auto", pricing: null },
    ]);

    expect((await chat.listGuestModels()).map((model) => model.id)).toEqual([
      "at-ceiling/model",
      "cheap/model",
      "free/model:free",
    ]);
    expect(await chat.isGuestModel("cheap/model")).toBe(true);
    expect(await chat.isGuestModel("dear-output/model")).toBe(false);
  });
});

describe("findChatModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrSetCache.mockResolvedValue([sampleModel]);
  });

  it("finds a listed model by id", async () => {
    expect(await chat.findModel(MODEL_ID)).toEqual(sampleModel);
  });

  it("finds nothing for an id that isn't listed", async () => {
    expect(await chat.findModel("unknown/model")).toBeUndefined();
  });
});

describe("buildUserTurn", () => {
  it("keeps a turn without images a plain string", () => {
    expect(buildUserTurn("Hi there")).toEqual({
      role: "user",
      content: "Hi there",
    });
  });

  it("puts the text first, then one part per image", () => {
    expect(
      buildUserTurn("What is this?", ["https://bucket.test/a.png"]),
    ).toEqual({
      role: "user",
      content: [
        { type: "input_text", text: "What is this?" },
        {
          type: "input_image",
          detail: "auto",
          imageUrl: "https://bucket.test/a.png",
        },
      ],
    });
  });
});

describe("chatAI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sentWithKeys.length = 0;
  });

  it("bills a guest's call to the guest key, and anyone else's to the main one", async () => {
    mockResponsesSend.mockResolvedValue(responseOf("hi"));

    await chat.complete(MODEL_ID, [{ role: "user", content: "yo" }], {
      guest: true,
    });
    await chat.complete(MODEL_ID, [{ role: "user", content: "yo" }]);
    await chat.generateTitle("conversation", "yo", { guest: true });

    expect(sentWithKeys).toEqual([
      process.env.OPENROUTER_GUEST_API_KEY,
      process.env.OPENROUTER_API_KEY,
      process.env.OPENROUTER_GUEST_API_KEY,
    ]);
  });

  it("offers the web tools, within their limits, only when asked", async () => {
    mockResponsesSend.mockResolvedValue((async function* () {})());

    await chat.complete(MODEL_ID, [{ role: "user", content: "yo" }], {
      onDelta: () => {},
    });
    await chat.complete(MODEL_ID, [{ role: "user", content: "yo" }], {
      onDelta: () => {},
      webSearch: true,
      onSource: () => {},
    });

    const requestOf = (call: number) =>
      (mockResponsesSend.mock.calls[call]?.[0] as { responsesRequest: object })
        .responsesRequest;
    expect(requestOf(0)).toMatchObject({
      tools: undefined,
      instructions: undefined,
    });
    expect(requestOf(1)).toMatchObject({
      tools: [
        {
          type: "openrouter:web_search",
          parameters: {
            engine: "exa",
            maxUses: 3,
            maxResults: 3,
            maxTotalResults: 9,
          },
        },
        {
          type: "openrouter:web_fetch",
          parameters: { engine: "exa", maxUses: 5, maxContentTokens: 8_000 },
        },
      ],
      instructions: expect.stringContaining("say so plainly"),
    });
  });

  it("routes for low latency and pins the session for prompt-cache hits", async () => {
    mockResponsesSend.mockResolvedValueOnce(responseOf("hi"));

    const result = await chat.complete(
      MODEL_ID,
      [{ role: "user", content: "yo" }],
      {
        maxOutputTokens: 100,
        sessionId: "conversation-1",
      },
    );

    expect(result).toBe("hi");
    expect(mockResponsesSend).toHaveBeenCalledWith(
      {
        responsesRequest: expect.objectContaining({
          model: MODEL_ID,
          maxOutputTokens: 100,
          provider: { sort: "latency" },
          sessionId: "conversation-1",
        }),
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("reports the usage that ends a stream", async () => {
    const usage = {
      inputTokens: 3_000,
      outputTokens: 20,
      inputTokensDetails: { cachedTokens: 2_900 },
    };
    mockResponsesSend.mockResolvedValueOnce(
      (async function* () {
        yield textDelta("hi");
        yield { type: "response.completed", response: { usage } };
      })(),
    );
    const onUsage = vi.fn();

    const reply = await chat.complete(
      MODEL_ID,
      [{ role: "user", content: "yo" }],
      { onDelta: () => {}, onUsage },
    );

    expect(reply).toBe("hi");
    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledWith(usage);
  });

  it("names the pages behind a reply, and the ones it couldn't read", async () => {
    mockResponsesSend.mockResolvedValueOnce(
      (async function* () {
        yield {
          type: "response.output_item.done",
          item: {
            type: "openrouter:web_fetch",
            status: "incomplete",
            url: "https://blocked.test/thread",
            error: "No content",
          },
        };
        yield {
          type: "response.output_item.done",
          item: {
            type: "openrouter:web_fetch",
            status: "completed",
            url: "https://read.test/page",
            title: "A page it read",
          },
        };
        yield {
          type: "response.output_item.done",
          item: { type: "openrouter:web_search", status: "completed" },
        };
        yield textDelta("hi");
        yield {
          type: "response.output_item.done",
          item: {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "hi",
                annotations: [
                  {
                    type: "file_citation",
                    fileId: "f",
                    filename: "f",
                    index: 0,
                  },
                  {
                    type: "url_citation",
                    url: "https://found.test/page",
                    title: "A page a search found",
                  },
                ],
              },
            ],
          },
        };
      })(),
    );
    const onSource = vi.fn();
    const onUnreadPage = vi.fn();

    await chat.complete(MODEL_ID, [{ role: "user", content: "yo" }], {
      onDelta: () => {},
      webSearch: true,
      onSource,
      onUnreadPage,
    });

    expect(onSource.mock.calls).toEqual([
      ["https://read.test/page", "A page it read"],
      ["https://found.test/page", "A page a search found"],
    ]);
    expect(onUnreadPage.mock.calls).toEqual([
      ["https://blocked.test/thread", "No content"],
    ]);
  });

  it.each([
    ["response.failed", { response: { error: { message: "It broke" } } }],
    ["error", { message: "It broke" }],
  ])("fails the reply on a %s event", async (type, event) => {
    mockResponsesSend.mockResolvedValueOnce(
      (async function* () {
        yield textDelta("part");
        yield { type, ...event };
      })(),
    );

    await expect(
      chat.complete(MODEL_ID, [{ role: "user", content: "yo" }], {
        onDelta: () => {},
      }),
    ).rejects.toThrow("It broke");
  });
});

type SendOptions = { signal: AbortSignal };

/**
 * Waits `milliseconds` (forever when omitted), rejecting with the abort reason
 * once `signal` aborts — how the real SDK's request and stream behave. chatAI
 * relies on that, so a mock that ignored the signal would hide a regression.
 */
function abortableWait(signal: AbortSignal, milliseconds?: number) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer =
      milliseconds === undefined
        ? undefined
        : setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** A send() that streams each chunk after its delay, then stalls (or ends, with `end`), like a provider sending only keep-alives. */
function streamingSend(
  chunks: { afterMs: number; content: string }[],
  { end = false } = {},
) {
  return async (_request: unknown, { signal }: SendOptions) =>
    (async function* () {
      for (const chunk of chunks) {
        await abortableWait(signal, chunk.afterMs);
        yield textDelta(chunk.content);
      }
      if (!end) await abortableWait(signal);
    })();
}

const timedOut = (message: string) =>
  expect.objectContaining({ name: "TimeoutError", message });

function track(promise: Promise<unknown>) {
  const outcome: { settled: boolean; value?: unknown } = { settled: false };
  promise.then(
    (value) => Object.assign(outcome, { settled: true, value }),
    (error) => Object.assign(outcome, { settled: true, value: error }),
  );
  return outcome;
}

describe("chatAI timeouts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const TOTAL_TIMEOUT_MS = 8 * 60_000;
  const FIRST_TOKEN_TIMEOUT_MS = 6 * 60_000;
  const BETWEEN_CHUNKS_TIMEOUT_MS = 30_000;
  const TITLE_TIMEOUT_MS = 15_000;

  const streamChat = () =>
    chat.complete(MODEL_ID, [{ role: "user", content: "yo" }], {
      onDelta: () => {},
    });

  it("gives up when the stream goes quiet after the first token", async () => {
    mockResponsesSend.mockImplementationOnce(
      streamingSend([{ afterMs: 1_000, content: "hello" }]),
    );
    const outcome = track(streamChat());

    await vi.advanceTimersByTimeAsync(1_000 + BETWEEN_CHUNKS_TIMEOUT_MS - 1);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.value).toEqual(timedOut("No progress for 30000 ms"));
  });

  it("waits longer for the first token than between chunks", async () => {
    mockResponsesSend.mockImplementationOnce(streamingSend([]));
    const outcome = track(streamChat());

    await vi.advanceTimersByTimeAsync(FIRST_TOKEN_TIMEOUT_MS - 1);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.value).toEqual(timedOut("No progress within 360000 ms"));
  });

  it("waits longer between chunks when the model can stop to search", async () => {
    mockResponsesSend.mockImplementationOnce(
      streamingSend([{ afterMs: 1_000, content: "hello" }]),
    );
    const outcome = track(
      chat.complete(MODEL_ID, [{ role: "user", content: "yo" }], {
        onDelta: () => {},
        webSearch: true,
        onSource: () => {},
      }),
    );

    await vi.advanceTimersByTimeAsync(1_000 + 2 * 60_000 - 1);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.value).toEqual(timedOut("No progress for 120000 ms"));
  });

  it("fails when the model reaches its ceiling before writing anything", async () => {
    mockResponsesSend.mockImplementationOnce(async () =>
      (async function* () {
        yield {
          type: "response.incomplete",
          response: { incompleteDetails: { reason: "max_output_tokens" } },
        };
      })(),
    );

    await expect(streamChat()).rejects.toBeInstanceOf(NoRoomToReply);
  });

  it("keeps what the model wrote before reaching its ceiling", async () => {
    mockResponsesSend.mockImplementationOnce(async () =>
      (async function* () {
        yield textDelta("cut ");
        yield textDelta("off");
        yield {
          type: "response.incomplete",
          response: { incompleteDetails: { reason: "max_output_tokens" } },
        };
      })(),
    );

    await expect(streamChat()).resolves.toBe("cut off");
  });

  it("keeps waiting for the first token after an empty chunk", async () => {
    mockResponsesSend.mockImplementationOnce(
      async (_request: unknown, { signal }: SendOptions) =>
        (async function* () {
          yield textDelta("");
          await abortableWait(signal, 60_000);
          yield textDelta("answer");
        })(),
    );
    const outcome = track(streamChat());

    await vi.advanceTimersByTimeAsync(60_000);
    expect(outcome.value).toBe("answer");
  });

  it("keeps a slow but steady stream going", async () => {
    const chunks = Array.from({ length: 5 }, (_, index) => ({
      afterMs: BETWEEN_CHUNKS_TIMEOUT_MS - 1_000,
      content: `t${index}`,
    }));
    const deltas: string[] = [];
    mockResponsesSend.mockImplementationOnce(
      streamingSend(chunks, { end: true }),
    );
    const outcome = track(
      chat.complete(MODEL_ID, [{ role: "user", content: "yo" }], {
        onDelta: (delta) => {
          deltas.push(delta);
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(5 * BETWEEN_CHUNKS_TIMEOUT_MS);
    expect(outcome.value).toBe("t0t1t2t3t4");
    expect(deltas).toEqual(["t0", "t1", "t2", "t3", "t4"]);
  });

  it("ends a stream that never stops sending before the claim lease expires", async () => {
    mockResponsesSend.mockImplementationOnce(
      async (_request: unknown, { signal }: SendOptions) =>
        (async function* () {
          for (;;) {
            await abortableWait(signal, 10_000);
            yield textDelta(".");
          }
        })(),
    );
    const outcome = track(streamChat());

    await vi.advanceTimersByTimeAsync(TOTAL_TIMEOUT_MS - 1);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.value).toEqual(
      timedOut("Operation took longer than 480000 ms"),
    );
    expect(TOTAL_TIMEOUT_MS).toBeLessThan(CLAIM_LEASE_MS);
  });

  it("gives up on a title that never arrives", async () => {
    mockResponsesSend.mockImplementationOnce(
      (_request: unknown, { signal }: SendOptions) => abortableWait(signal),
    );
    const outcome = track(chat.generateTitle("conversation", "hello"));

    await vi.advanceTimersByTimeAsync(TITLE_TIMEOUT_MS - 1);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.value).toEqual(
      timedOut("Operation took longer than 15000 ms"),
    );
  });
});

describe("generateTitle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the title model, without reasoning, and returns a trimmed title", async () => {
    mockResponsesSend.mockResolvedValueOnce(
      responseOf("  Quarterly planning  "),
    );

    const title = await chat.generateTitle(
      "conversation",
      "How should we organize the next quarter?",
    );

    expect(title).toBe("Quarterly planning");
    expect(mockResponsesSend).toHaveBeenCalledWith(
      {
        responsesRequest: expect.objectContaining({
          model: "~openai/gpt-luna-latest",
          input: [
            {
              role: "user",
              content: expect.stringContaining(
                "How should we organize the next quarter?",
              ),
            },
          ],
          maxOutputTokens: 24,
          reasoning: { effort: "none" },
        }),
      },
      { signal: expect.any(AbortSignal) },
    );
  });
});
