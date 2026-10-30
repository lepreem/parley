import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CACHE_KEYS } from "../../src/memory/modelLists";
import { CLAIM_LEASE_MS } from "../../src/data/conversations.data";

const { mockGetOrSetCache, mockModelsList, mockChatSend, sentWithKeys } =
  vi.hoisted(() => ({
    mockGetOrSetCache: vi.fn(),
    mockModelsList: vi.fn(),
    mockChatSend: vi.fn(),
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
    chat = {
      send: (...args: unknown[]) => {
        sentWithKeys.push(this.options.apiKey);
        return mockChatSend(...args);
      },
    };
  },
}));

import { buildUserTurn, chat } from "../../src/ai/ai_chat_client";

const MODEL_ID = "openai/gpt-4o-mini";

// How the app describes the OpenRouter model below: only what it uses.
const sampleModel = {
  id: MODEL_ID,
  name: "GPT-4o Mini",
  contextTokens: 128000,
  acceptsImages: true,
  pricing: { inputPerMillionTokens: 0.15, outputPerMillionTokens: 0.6 },
};

const openRouterListModel = {
  id: MODEL_ID,
  name: "GPT-4o Mini",
  description: "Fast chat model",
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
        acceptsImages: false,
        pricing: { inputPerMillionTokens: 0.15, outputPerMillionTokens: 0.6 },
      },
      {
        id: "openrouter/auto",
        name: "Auto Router",
        contextTokens: 128000,
        acceptsImages: true,
        pricing: null,
      },
    ]);
    // Only text-output models are relevant here; transcription is Deepgram's.
    expect(mockModelsList).toHaveBeenCalledWith({ outputModalities: "text" });
  });

  it("leaves out batch-only variants, which can't stream a reply", async () => {
    mockGetOrSetCache.mockImplementationOnce(runFetch);
    mockModelsList.mockResolvedValueOnce({
      result: {
        data: [
          openRouterListModel,
          { ...openRouterListModel, id: `${openRouterListModel.id}:batch` },
        ],
      },
    });

    expect(await chat.listModels()).toEqual([sampleModel]);
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

  it("offers gpt-4o-mini and what costs no more, for input and output both", async () => {
    mockGetOrSetCache.mockResolvedValue([
      priced(MODEL_ID, 0.15, 0.6),
      priced("cheap/model", 0.1, 0.4),
      priced("free/model:free", 0, 0),
      priced("dear-input/model", 0.2, 0.4),
      priced("dear-output/model", 0.1, 0.8),
      { ...sampleModel, id: "openrouter/auto", pricing: null },
    ]);

    expect((await chat.listGuestModels()).map((model) => model.id)).toEqual([
      MODEL_ID,
      "cheap/model",
      "free/model:free",
    ]);
    expect(await chat.isGuestModel("cheap/model")).toBe(true);
    expect(await chat.isGuestModel("dear-output/model")).toBe(false);
  });

  it("offers nothing while gpt-4o-mini is missing from the catalog", async () => {
    mockGetOrSetCache.mockResolvedValue([priced("cheap/model", 0.1, 0.4)]);

    expect(await chat.listGuestModels()).toEqual([]);
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
        { type: "text", text: "What is this?" },
        {
          type: "image_url",
          imageUrl: { url: "https://bucket.test/a.png" },
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
    mockChatSend.mockResolvedValue({
      choices: [{ message: { content: "hi" } }],
    });

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

  it("routes for low latency and pins the session for prompt-cache hits", async () => {
    mockChatSend.mockResolvedValueOnce({
      choices: [{ message: { content: "hi" } }],
    });

    const result = await chat.complete(
      MODEL_ID,
      [{ role: "user", content: "yo" }],
      {
        maxOutputTokens: 100,
        sessionId: "conversation-1",
      },
    );

    expect(result).toBe("hi");
    expect(mockChatSend).toHaveBeenCalledWith(
      {
        chatRequest: expect.objectContaining({
          model: MODEL_ID,
          maxCompletionTokens: 100,
          provider: { sort: "latency" },
          sessionId: "conversation-1",
        }),
      },
      { signal: expect.any(AbortSignal) },
    );
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
        yield { choices: [{ delta: { content: chunk.content } }] };
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
  const FIRST_TOKEN_TIMEOUT_MS = 2 * 60_000;
  const BETWEEN_CHUNKS_TIMEOUT_MS = 30_000;
  const TITLE_TIMEOUT_MS = 15_000;

  const streamChat = () =>
    chat.complete(MODEL_ID, [{ role: "user", content: "yo" }], {
      onDelta: () => {},
    });

  it("gives up when the stream goes quiet after the first token", async () => {
    mockChatSend.mockImplementationOnce(
      streamingSend([{ afterMs: 1_000, content: "hello" }]),
    );
    const outcome = track(streamChat());

    await vi.advanceTimersByTimeAsync(1_000 + BETWEEN_CHUNKS_TIMEOUT_MS - 1);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.value).toEqual(timedOut("No progress for 30000 ms"));
  });

  it("waits longer for the first token than between chunks", async () => {
    mockChatSend.mockImplementationOnce(streamingSend([]));
    const outcome = track(streamChat());

    await vi.advanceTimersByTimeAsync(FIRST_TOKEN_TIMEOUT_MS - 1);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.value).toEqual(timedOut("No progress within 120000 ms"));
  });

  it("keeps waiting for the first token after an empty chunk", async () => {
    mockChatSend.mockImplementationOnce(
      async (_request: unknown, { signal }: SendOptions) =>
        (async function* () {
          yield { choices: [{ delta: { role: "assistant", content: "" } }] };
          await abortableWait(signal, 60_000);
          yield { choices: [{ delta: { content: "answer" } }] };
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
    mockChatSend.mockImplementationOnce(streamingSend(chunks, { end: true }));
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
    mockChatSend.mockImplementationOnce(
      async (_request: unknown, { signal }: SendOptions) =>
        (async function* () {
          for (;;) {
            await abortableWait(signal, 10_000);
            yield { choices: [{ delta: { content: "." } }] };
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
    mockChatSend.mockImplementationOnce(
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

  it("uses the default model and returns a trimmed title", async () => {
    mockChatSend.mockResolvedValueOnce({
      choices: [{ message: { content: "  Quarterly planning  " } }],
    });

    const title = await chat.generateTitle(
      "conversation",
      "How should we organize the next quarter?",
    );

    expect(title).toBe("Quarterly planning");
    expect(mockChatSend).toHaveBeenCalledWith(
      {
        chatRequest: expect.objectContaining({
          model: MODEL_ID,
          messages: [
            {
              role: "user",
              content: expect.stringContaining(
                "How should we organize the next quarter?",
              ),
            },
          ],
          maxCompletionTokens: 24,
        }),
      },
      { signal: expect.any(AbortSignal) },
    );
  });
});
