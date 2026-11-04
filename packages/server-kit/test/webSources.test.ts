import { describe, expect, it } from "vitest";
import type { MessageSource } from "@parley/contract";
import { addSource } from "@parley/server-kit/webSources";

function added(...pages: [url: unknown, title: unknown][]) {
  const sources: MessageSource[] = [];
  for (const [url, title] of pages) addSource(sources, url, title);
  return sources;
}

describe("addSource", () => {
  it("keeps a page once, by its address", () => {
    expect(
      added(["https://a.example/x", "First"], ["https://a.example/x", "Again"]),
    ).toEqual([{ url: "https://a.example/x", title: "First" }]);
  });

  it("only takes http and https addresses, since the client links them", () => {
    expect(
      added(
        ["javascript:alert(1)", "Script"],
        ["data:text/html,hi", "Data"],
        ["not a url", "Text"],
        [42, "Number"],
        [undefined, "Nothing"],
      ),
    ).toEqual([]);
  });

  it("falls back to the site for a page with no title", () => {
    expect(
      added(["https://a.example/x", "  "], ["https://b.example/y", null]),
    ).toEqual([
      { url: "https://a.example/x", title: "a.example" },
      { url: "https://b.example/y", title: "b.example" },
    ]);
  });

  it("caps how many it keeps, and how long a title can be", () => {
    const many = Array.from({ length: 30 }, (_, i): [string, string] => [
      `https://a.example/${i}`,
      "x".repeat(500),
    ]);
    const sources = added(...many);
    expect(sources).toHaveLength(20);
    expect(sources[0]?.title).toHaveLength(200);
  });
});
