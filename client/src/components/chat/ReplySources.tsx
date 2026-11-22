import type { MessageSource } from "../../api/messages";
import { Icon } from "../ui/Icon";

/** "www.nodejs.org" as "nodejs.org". */
function siteOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

/**
 * The web pages the model found or read for a reply, each a link to the page,
 * then the sites of any it tried to open and couldn't, so a reply that says it
 * couldn't read a page isn't followed by sources that look like it did.
 */
export function ReplySources({ sources }: { sources: MessageSource[] }) {
  const read = sources.filter((source) => !source.unread);
  const unreadSites = [
    ...new Set(
      sources
        .filter((source) => source.unread)
        .map((source) => siteOf(source.url)),
    ),
  ];

  return (
    <div className="mt-3">
      {read.length > 0 && (
        <>
          <p className="eyebrow mb-1.5 text-faint">Sources</p>
          <ul className="flex flex-wrap gap-1.5">
            {read.map((source) => (
              <li key={source.url} className="min-w-0">
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={source.title}
                  className="flex max-w-[16rem] items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-muted transition-colors hover:bg-sunk hover:text-ink"
                >
                  <Icon name="link" className="h-3 w-3 shrink-0" />
                  <span className="truncate">{siteOf(source.url)}</span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
      {unreadSites.length > 0 && (
        <p className={`text-xs text-faint ${read.length > 0 ? "mt-2" : ""}`}>
          Couldn&rsquo;t open a page on {unreadSites.join(", ")}
        </p>
      )}
    </div>
  );
}
