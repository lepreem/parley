import type { MessageSource } from "@parley/contract";

const MAX_SOURCES = 20;
const MAX_TITLE_LENGTH = 200;

/**
 * Adds a page a web search found to a reply's sources. All of this comes from
 * the web by way of a model, and the client makes links of it, so only an
 * http(s) address gets in. Each page counts once.
 */
export function addSource(
  sources: MessageSource[],
  url: unknown,
  title: unknown,
): void {
  if (typeof url !== "string" || sources.length >= MAX_SOURCES) return;
  if (!URL.canParse(url)) return;
  const { href, hostname, protocol } = new URL(url);
  if (protocol !== "http:" && protocol !== "https:") return;
  if (sources.some((source) => source.url === href)) return;
  const named = typeof title === "string" ? title.trim() : "";
  sources.push({
    url: href,
    title: named.slice(0, MAX_TITLE_LENGTH) || hostname,
  });
}
