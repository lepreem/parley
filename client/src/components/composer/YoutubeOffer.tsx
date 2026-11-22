import { Icon } from "../ui/Icon";
import { youtubeLabel } from "../../media/youtube";
import { buttonClass } from "../ui/buttonClass";

/**
 * A pasted link is a hint, not an instruction — so this asks rather than acts.
 * The URL stays in the message either way.
 */
export function YoutubeOffer({
  url,
  onAccept,
  onDismiss,
}: {
  url: string;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-signal/40 bg-signal-tint px-3 py-2">
      <Icon name="link" className="h-4 w-4 shrink-0 text-signal-ink" />
      <p className="min-w-0 flex-1 text-[13px] text-ink">
        That's a YouTube link —{" "}
        <span className="font-mono text-[11px] text-muted">
          {youtubeLabel(url)}
        </span>
        . Transcribe it and attach the transcript?
      </p>
      <span className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={onDismiss}
          className={buttonClass("quiet", "sm")}
        >
          Not now
        </button>
        <button
          type="button"
          onClick={onAccept}
          className={buttonClass("primary", "sm")}
        >
          Add transcript
        </button>
      </span>
    </div>
  );
}
