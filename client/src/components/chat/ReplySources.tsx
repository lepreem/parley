import type { MessageSource } from "../../api/messages";
import { Icon } from "../ui/Icon";

/** "www.nodejs.org" as "nodejs.org". */
function siteOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

/** The web pages the model found or read for a reply, each a link to the page. */
export function ReplySources({ sources }: { sources: MessageSource[] }) {
  return (
    <div className="mt-3">
      <p className="eyebrow mb-1.5 text-faint">Sources</p>
      <ul className="flex flex-wrap gap-1.5">
        {sources.map((source) => (
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
    </div>
  );
}
