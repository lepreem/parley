import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readCitationLine,
  tapCitations,
} from "../../src/ai/ai_chat_client/citationTap";

const chunkWith = (url: string, title: string) =>
  `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          annotations: [{ type: "url_citation", url_citation: { url, title } }],
        },
      },
    ],
  })}`;

describe("readCitationLine", () => {
  it("hands over the citations in a chunk", () => {
    const onCitation = vi.fn();
    readCitationLine(chunkWith("https://a.example/", "A"), onCitation);
    expect(onCitation).toHaveBeenCalledWith("https://a.example/", "A");
  });

  it("ignores lines that aren't citations, or aren't JSON", () => {
    const onCitation = vi.fn();
    readCitationLine(
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      onCitation,
    );
    readCitationLine(": OPENROUTER PROCESSING", onCitation);
    readCitationLine("data: [DONE]", onCitation);
    readCitationLine("data: {not json url_citation", onCitation);
    expect(onCitation).not.toHaveBeenCalled();
  });
});

describe("tapCitations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const respondingWith = (...parts: string[]) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
    );
  };

  it("reads citations and leaves the whole stream for the SDK, across chunk boundaries", async () => {
    const line = chunkWith("https://a.example/", "A");
    const middle = Math.floor(line.length / 2);
    respondingWith(
      line.slice(0, middle),
      `${line.slice(middle)}\n`,
      "data: end\n",
    );
    const onCitation = vi.fn();

    const tap = tapCitations(onCitation);
    const response = await tap.fetcher("https://openrouter.example/", {});
    const text = await response.text();
    await tap.finished();

    expect(text).toBe(`${line}\ndata: end\n`);
    expect(onCitation).toHaveBeenCalledExactlyOnceWith(
      "https://a.example/",
      "A",
    );
  });

  it("passes on a failed response untouched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 429 })),
    );
    const onCitation = vi.fn();

    const tap = tapCitations(onCitation);
    const response = await tap.fetcher("https://openrouter.example/", {});

    expect(response.status).toBe(429);
    expect(await response.text()).toBe("nope");
    expect(onCitation).not.toHaveBeenCalled();
  });
});
