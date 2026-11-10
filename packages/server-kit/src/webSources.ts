import type { MessageSource } from "@parley/contract";

const MAX_SOURCES = 20;
const MAX_TITLE_LENGTH = 200;

/**
 * A source as a server stores it: with the text of a page the model read, so
 * later turns can carry it instead of opening the page again. The text never
 * goes to the client.
 */
export type StoredSource = MessageSource & { content?: string };

/** An http(s) address as one form, or undefined for anything else. */
function pageAddress(url: unknown) {
  if (typeof url !== "string" || !URL.canParse(url)) return undefined;
  const address = new URL(url);
  if (address.protocol !== "http:" && address.protocol !== "https:") return;
  return address;
}

/**
 * Adds a page the model found or read to a reply's sources. All of this comes from
 * the web by way of a model, and the client makes links of it, so only an
 * http(s) address gets in. Each page counts once: reading a page it had
 * failed to open, or the text of one it had only cited, fills in the entry
 * it already has.
 */
export function addSource<Source extends StoredSource>(
  sources: Source[],
  url: unknown,
  title: unknown,
  content?: string,
): void {
  const address = pageAddress(url);
  if (!address) return;
  const named = typeof title === "string" ? title.trim() : "";
  const read = {
    url: address.href,
    title: named.slice(0, MAX_TITLE_LENGTH) || address.hostname,
    ...(content ? { content } : {}),
  } as Source;

  const index = sources.findIndex((source) => source.url === address.href);
  const existing = sources[index];
  if (!existing) {
    if (sources.length < MAX_SOURCES) sources.push(read);
    return;
  }
  if (existing.unread) {
    sources[index] = read;
  } else if (content && !existing.content) {
    sources[index] = { ...existing, content };
  }
}

/** Adds a page the model tried to open and couldn't, unless it's there already. */
export function addUnreadPage(sources: MessageSource[], url: unknown): void {
  const address = pageAddress(url);
  if (!address || sources.length >= MAX_SOURCES) return;
  if (sources.some((source) => source.url === address.href)) return;
  sources.push({ url: address.href, title: address.hostname, unread: true });
}

/** Sources as the client gets them: without the text of the pages. */
export function withoutPageText(sources: readonly StoredSource[]) {
  return sources.map(
    ({ content: _content, ...source }): MessageSource => source,
  );
}
