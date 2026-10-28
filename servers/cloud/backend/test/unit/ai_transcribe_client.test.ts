import { describe, it, expect, vi, beforeEach } from "vitest";
import { CACHE_KEYS } from "../../src/memory/modelLists";

const { mockModelsList, mockGetOrSetCache, mockTranscribeUrl } = vi.hoisted(
  () => ({
    mockModelsList: vi.fn(),
    mockGetOrSetCache: vi.fn(),
    mockTranscribeUrl: vi.fn(),
  }),
);

vi.mock("@deepgram/sdk", () => ({
  DeepgramClient: class {
    manage = { v1: { models: { list: mockModelsList } } };
    auth = { v1: { tokens: { grant: vi.fn() } } };
    listen = { v1: { media: { transcribeUrl: mockTranscribeUrl } } };
  },
}));

vi.mock("../../src/memory/modelLists", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/memory/modelLists")>()),
  modelLists: { getOrSet: mockGetOrSetCache },
}));

/** Caching itself is covered in modelLists.test.ts; here the fetch always runs. */
const runFetch = <T>(_name: unknown, fetch: () => Promise<T>) => fetch();

import {
  DEFAULT_TRANSCRIBE_MODEL,
  getTranscribeModelData,
  transcription,
} from "../../src/ai/ai_transcribe_client";

const sttResponse = {
  stt: [
    {
      name: "general",
      canonical_name: "nova-3-general",
      architecture: "nova-3",
      languages: ["en"],
      version: "1",
      uuid: "u1",
      batch: true,
      streaming: true,
      formatted_output: true,
    },
    { name: "general", canonical_name: "nova-2-general", uuid: "u2" },
  ],
};

describe("transcribe", () => {
  it("answers Deepgram's utterances as segments", async () => {
    mockTranscribeUrl.mockResolvedValue({
      results: {
        channels: [],
        utterances: [
          { start: 0.5, end: 2, transcript: "Hello there." },
          { start: 4, end: 5.25, transcript: "Next." },
        ],
      },
    });

    expect(
      await transcription.transcribe("nova-3-general", "https://audio"),
    ).toEqual([
      { start: 0.5, end: 2, text: "Hello there." },
      { start: 4, end: 5.25, text: "Next." },
    ]);
    expect(mockTranscribeUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://audio",
        model: "nova-3-general",
        utterances: true,
      }),
      expect.anything(),
    );
  });

  it("is empty when nothing was said", async () => {
    mockTranscribeUrl.mockResolvedValue({ results: { channels: [] } });

    expect(
      await transcription.transcribe("nova-3-general", "https://audio"),
    ).toEqual([]);
  });
});

describe("getTranscribeModelData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves the catalog through its cache entry", async () => {
    const cached = { "nova-3-general": { name: "nova-3" } };
    mockGetOrSetCache.mockResolvedValue(cached);

    expect(await getTranscribeModelData()).toBe(cached);
    expect(mockGetOrSetCache).toHaveBeenCalledWith(
      CACHE_KEYS.deepgramTranscribeModels,
      expect.any(Function),
      { serveStale: true },
    );
    expect(mockModelsList).not.toHaveBeenCalled();
  });

  it("shapes the stt models it fetches from Deepgram", async () => {
    mockGetOrSetCache.mockImplementation(runFetch);
    mockModelsList.mockResolvedValue(sttResponse);

    const data = await getTranscribeModelData();

    expect(mockModelsList).toHaveBeenCalledTimes(1);
    // Keyed by canonical_name.
    expect(Object.keys(data)).toEqual(["nova-3-general", "nova-2-general"]);
    expect(data["nova-3-general"]).toMatchObject({
      name: "general",
      canonicalName: "nova-3-general",
      formattedOutput: true,
    });
  });
});

describe("listTranscribeModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrSetCache.mockImplementation(runFetch);
    mockModelsList.mockResolvedValue(sttResponse);
  });

  it("lists the offered models the catalog has, by canonical name", async () => {
    expect(await transcription.listModels()).toEqual([
      { id: "nova-3-general", name: "Nova 3" },
      { id: "nova-2-general", name: "Nova 2" },
    ]);
  });

  it("leaves out catalog models that aren't offered", async () => {
    mockModelsList.mockResolvedValue({
      stt: [
        ...sttResponse.stt,
        { name: "drivethru", canonical_name: "nova-2-drivethru", uuid: "u3" },
      ],
    });
    const ids = (await transcription.listModels()).map((model) => model.id);
    expect(ids).not.toContain("nova-2-drivethru");
  });
});

describe("isValidTranscribeModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrSetCache.mockImplementation(runFetch);
    mockModelsList.mockResolvedValue(sttResponse);
  });

  it("accepts a model by its canonical_name", async () => {
    expect(await transcription.isValidModel("nova-3-general")).toBe(true);
  });

  it("rejects a display name, which repeats across generations", async () => {
    expect(await transcription.isValidModel("general")).toBe(false);
  });

  it("accepts the default when display names differ from model IDs", async () => {
    expect(await transcription.isValidModel(DEFAULT_TRANSCRIBE_MODEL)).toBe(
      true,
    );
  });

  it("rejects an offered model that is not in the catalog", async () => {
    expect(await transcription.isValidModel("whisper-large")).toBe(false);
  });
});
