import { describe, expect, it } from "vitest";
import type { MessageSource } from "@parley/contract";
import {
  addSource,
  addUnreadPage,
  withoutPageText,
  type StoredSource,
} from "@parley/server-kit/webSources";

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

describe("pages read and unread", () => {
  it("keeps the text of a page it read, and fills it in for one only cited", () => {
    const sources: StoredSource[] = [];
    addSource(sources, "https://a.example/x", "Cited");
    addSource(sources, "https://a.example/x", "Read", "The page");
    addSource(sources, "https://a.example/x", "Again", "Other text");
    expect(sources).toEqual([
      { url: "https://a.example/x", title: "Cited", content: "The page" },
    ]);
  });

  it("marks a page it couldn't open, until it opens it", () => {
    const sources: StoredSource[] = [];
    addUnreadPage(sources, "https://www.reddit.com/r/x");
    addUnreadPage(sources, "https://www.reddit.com/r/x");
    addUnreadPage(sources, "javascript:alert(1)");
    expect(sources).toEqual([
      {
        url: "https://www.reddit.com/r/x",
        title: "www.reddit.com",
        unread: true,
      },
    ]);
    addSource(sources, "https://www.reddit.com/r/x", "Thread", "Text");
    expect(sources).toEqual([
      { url: "https://www.reddit.com/r/x", title: "Thread", content: "Text" },
    ]);
  });

  it("doesn't mark a page unread once it was read", () => {
    const sources: StoredSource[] = [];
    addSource(sources, "https://a.example/x", "Read", "Text");
    addUnreadPage(sources, "https://a.example/x");
    expect(sources[0]?.unread).toBeUndefined();
  });

  it("leaves the text out of what the client gets", () => {
    expect(
      withoutPageText([
        { url: "https://a.example/x", title: "A", content: "Text" },
        { url: "https://b.example/", title: "b.example", unread: true },
      ]),
    ).toEqual([
      { url: "https://a.example/x", title: "A" },
      { url: "https://b.example/", title: "b.example", unread: true },
    ]);
  });
});
