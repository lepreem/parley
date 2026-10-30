import {
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import type { ChatModel, MessageRequirements } from "../../api/models";
import { useShell } from "../app/shellContext";
import { useIsGuest } from "../../hooks/auth/useIsGuest";
import { findYoutubeUrl } from "../../media/youtube";
import { useSources } from "../../sources/useSources";
import { Icon } from "../ui/Icon";
import { Meter } from "../ui/Meter";
import { AttachMenu } from "./AttachMenu";
import { ModelPicker } from "./ModelPicker";
import { SourceChip } from "./SourceChip";
import { YoutubeOffer } from "./YoutubeOffer";

const MAX_MESSAGE_LENGTH = 50_000;
const MAX_TEXTAREA_HEIGHT_PX = 240;

type ComposerProps = {
  draftKey: string;
  text: string;
  onTextChange: (text: string) => void;
  models: ChatModel[];
  modelId: string | null;
  onModelChange: (modelId: string) => void;
  modelsLoading: boolean;
  modelsError: string | null;
  requirements: MessageRequirements;
  sending: boolean;
  canSend: boolean;
  /** Set while a reply is being written that the stop button can reach. */
  onStop: (() => void) | null;
  stopping: boolean;
  /** What the send is waiting on, if anything — shown under the box. */
  blockedReason: string | null;
  onSend: () => void;
};

export function Composer({
  draftKey,
  text,
  onTextChange,
  models,
  modelId,
  onModelChange,
  modelsLoading,
  modelsError,
  requirements,
  sending,
  canSend,
  onStop,
  stopping,
  blockedReason,
  onSend,
}: ComposerProps) {
  const { setSourcesOpen } = useShell();
  // Guests chat in text only; the server refuses their uploads.
  const guest = useIsGuest();
  const {
    sources,
    addFiles,
    addYoutube,
    removeSource,
    retrySource,
    transcriptModelId,
    setTranscriptModelId,
  } = useSources(draftKey);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Held with the draft it belongs to, so declining an offer in one chat
  // doesn't silence the same link in another — and nothing has to be reset.
  const [dismissed, setDismissed] = useState({
    draftKey,
    urls: [] as string[],
  });
  const dismissedUrls = dismissed.draftKey === draftKey ? dismissed.urls : [];

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, [text]);

  const candidateUrl = findYoutubeUrl(text);
  const offeredUrl =
    !guest &&
    candidateUrl &&
    !dismissedUrls.includes(candidateUrl) &&
    !sources.some((source) => source.youtubeUrl === candidateUrl)
      ? candidateUrl
      : null;

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend) onSend();
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (guest || files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };

  return (
    <div className="shrink-0 px-4 pb-4">
      <div className="mx-auto w-full max-w-[46rem]">
        {offeredUrl && (
          <YoutubeOffer
            url={offeredUrl}
            onAccept={() => addYoutube(offeredUrl)}
            onDismiss={() =>
              setDismissed((current) => ({
                draftKey,
                urls:
                  current.draftKey === draftKey
                    ? [...current.urls, offeredUrl]
                    : [offeredUrl],
              }))
            }
          />
        )}

        {sources.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-2">
            {sources.map((source) => (
              <SourceChip
                key={source.localId}
                source={source}
                onRemove={() => removeSource(source.localId)}
                onRetry={() => retrySource(source.localId)}
              />
            ))}
          </ul>
        )}

        <div className="rounded-2xl border border-line bg-surface transition-colors focus-within:border-signal">
          <label htmlFor="composer" className="sr-only">
            Message
          </label>
          <textarea
            id="composer"
            ref={textareaRef}
            rows={1}
            value={text}
            maxLength={MAX_MESSAGE_LENGTH}
            onChange={(event) => onTextChange(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={guest ? "Ask anything…" : "Ask about your sources…"}
            className="block max-h-60 w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-relaxed outline-none placeholder:text-faint"
          />

          <div className="flex items-center gap-1 px-2.5 pb-2.5 pt-1">
            {!guest && (
              <AttachMenu
                onAddFiles={addFiles}
                onBrowseSources={() => setSourcesOpen(true)}
                transcriptModelId={transcriptModelId}
                onTranscriptModelChange={setTranscriptModelId}
              />
            )}
            <ModelPicker
              models={models}
              value={modelId}
              onChange={onModelChange}
              requirements={requirements}
              loading={modelsLoading}
              error={modelsError}
            />
            <span className="flex-1" />
            {sending ? (
              <button
                type="button"
                onClick={onStop ?? undefined}
                disabled={!onStop || stopping}
                aria-label={
                  stopping
                    ? "Stopping the reply"
                    : onStop
                      ? "Stop the reply"
                      : "Waiting for the reply"
                }
                className="flex h-8 w-8 items-center justify-center rounded-full bg-signal text-white transition-colors hover:bg-signal-strong disabled:hover:bg-signal"
              >
                {onStop && !stopping ? (
                  <Icon name="stop" className="h-4 w-4" />
                ) : (
                  <Meter state="live" tone="current" className="h-3.5" />
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={onSend}
                disabled={!canSend}
                aria-label="Send message"
                className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                  canSend
                    ? "bg-signal text-white hover:bg-signal-strong"
                    : "bg-line text-faint"
                }`}
              >
                <Icon name="send" className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <p
          className="mt-2 min-h-4 px-1 text-[11px] text-faint"
          aria-live="polite"
        >
          {blockedReason ?? "Enter sends · Shift+Enter for a new line"}
        </p>
      </div>
    </div>
  );
}
