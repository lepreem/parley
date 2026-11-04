import type { Fetcher } from "@openrouter/sdk";

/**
 * OpenRouter says which pages a web search found as `url_citation` annotations
 * on the stream, and the SDK's parser drops them (still so in 1.5.42). This
 * reads them off the raw stream on the way past, leaving the SDK its own copy.
 */

type OnCitation = (url: unknown, title: unknown) => void;

/** Hands over the citations in one line of a server-sent event stream. */
export function readCitationLine(line: string, onCitation: OnCitation): void {
  if (!line.startsWith("data:") || !line.includes("url_citation")) return;

  let chunk: {
    choices?: {
      delta?: {
        annotations?: { url_citation?: { url?: unknown; title?: unknown } }[];
      };
    }[];
  };
  try {
    chunk = JSON.parse(line.slice("data:".length)) as typeof chunk;
  } catch {
    return;
  }
  for (const annotation of chunk.choices?.[0]?.delta?.annotations ?? []) {
    if (annotation.url_citation) {
      onCitation(annotation.url_citation.url, annotation.url_citation.title);
    }
  }
}

async function readCitations(
  body: ReadableStream<Uint8Array>,
  onCitation: OnCitation,
) {
  let partialLine = "";
  const decoder = new TextDecoder();
  for await (const bytes of body) {
    const text = decoder.decode(bytes, { stream: true });
    const lines = (partialLine + text).split("\n");
    partialLine = lines.pop() ?? "";
    for (const line of lines) readCitationLine(line, onCitation);
  }
}

/**
 * A fetch that taps each response for citations, and `finished`, for when the
 * latest response has been read to its end. A tap that fails only costs the
 * sources, which aren't worth failing a reply over.
 */
export function tapCitations(onCitation: OnCitation) {
  let reading: Promise<void> = Promise.resolve();
  return {
    fetcher: (async (input, init) => {
      const response = await fetch(input, init);
      if (!response.ok || !response.body) return response;

      const [forSdk, forTap] = response.body.tee();
      reading = readCitations(forTap, onCitation).catch(() => {});
      return new Response(forSdk, response);
    }) satisfies Fetcher,
    finished: () => reading,
  };
}
