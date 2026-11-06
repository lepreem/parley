import {
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import type {
  ChatModel,
  MessageRequirements,
  ReasoningEffort,
} from "../../api/models";
import { useShell } from "../app/shellContext";
import { useIsGuest } from "../../hooks/auth/useIsGuest";
import { findYoutubeUrl } from "../../media/youtube";
import { useSources } from "../../sources/useSources";
import { Icon } from "../ui/Icon";
import { Meter } from "../ui/Meter";
import { AttachMenu } from "./AttachMenu";
import { EffortPicker } from "./EffortPicker";
import { PermissionPicker } from "./PermissionPicker";
import type { PermissionMode } from "../../api/toolApprovals";
import { insertSpoken } from "./insertSpoken";
import { ModelPicker } from "./ModelPicker";
import { SourceChip } from "./SourceChip";
import { canDictate, useDictation } from "./useDictation";
import { YoutubeOffer } from "./YoutubeOffer";

const MAX_MESSAGE_LENGTH = 50_000;
const MAX_TEXTAREA_HEIGHT_PX = 240;

const clockTime = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

type ComposerProps = {
  draftKey: string;
  text: string;
  onTextChange: (text: string) => void;
  models: ChatModel[];
  modelId: string | null;
  onModelChange: (modelId: string) => void;
  effort: ReasoningEffort | null;
  onEffortChange: (effort: ReasoningEffort | null) => void;
  canSearchWeb: boolean;
  webSearch: boolean;
  onWebSearchChange: (on: boolean) => void;
  /** Whether this server's model asks before it acts: Claude Code does. */
  canChoosePermissions: boolean;
  permissionMode: PermissionMode | null;
  onPermissionModeChange: (mode: PermissionMode | null) => void;
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
  effort,
  onEffortChange,
  canSearchWeb,
  webSearch,
  onWebSearchChange,
  canChoosePermissions,
  permissionMode,
  onPermissionModeChange,
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
    useCaptionsIfAvailable,
    setUseCaptionsIfAvailable,
  } = useSources(draftKey);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const caretAfterDictation = useRef<number | null>(null);
  const { dictation, start, stop, reset, retry } = useDictation((spoken) => {
    const textarea = textareaRef.current;
    const inserted = insertSpoken(
      text,
      textarea?.selectionStart ?? text.length,
      textarea?.selectionEnd ?? text.length,
      spoken,
    );
    caretAfterDictation.current = inserted.caret;
    onTextChange(inserted.text.slice(0, MAX_MESSAGE_LENGTH));
  }, draftKey);
  // What's being said belongs in this draft, so it can't go out without it.
  const dictating =
    dictation.status === "recording" || dictation.status === "transcribing";
  const canSendNow = canSend && !dictating;
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
    if (caretAfterDictation.current !== null) {
      textarea.focus();
      textarea.setSelectionRange(
        caretAfterDictation.current,
        caretAfterDictation.current,
      );
      caretAfterDictation.current = null;
    }
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
      if (canSendNow) onSend();
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
                useCaptionsIfAvailable={useCaptionsIfAvailable}
                onUseCaptionsChange={setUseCaptionsIfAvailable}
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
            {!guest && (
              <EffortPicker
                reasoning={
                  models.find((model) => model.id === modelId)?.reasoning ??
                  null
                }
                value={effort}
                onChange={onEffortChange}
              />
            )}
            {canSearchWeb && (
              <button
                type="button"
                onClick={() => onWebSearchChange(!webSearch)}
                aria-label="Let the model use the web"
                aria-pressed={webSearch}
                title={
                  webSearch
                    ? "Web is on: the model can search and read pages"
                    : "Web is off"
                }
                className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
                  webSearch
                    ? "bg-signal-tint text-signal-strong"
                    : "text-muted hover:bg-sunk hover:text-ink"
                }`}
              >
                <Icon name="globe" className="h-4 w-4" />
              </button>
            )}
            {canChoosePermissions && (
              <PermissionPicker
                value={permissionMode}
                onChange={onPermissionModeChange}
              />
            )}
            <span className="flex-1" />
            {dictation.status === "recording" && (
              <>
                <span className="font-mono text-xs tabular-nums text-muted">
                  {clockTime(dictation.seconds)}
                </span>
                <button
                  type="button"
                  onClick={reset}
                  aria-label="Discard the recording"
                  className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:text-ink"
                >
                  <Icon name="close" className="h-4 w-4" />
                </button>
              </>
            )}
            {!guest && canDictate() && (
              <button
                type="button"
                onClick={
                  dictation.status === "recording" ? stop : () => void start()
                }
                disabled={dictation.status === "transcribing"}
                aria-label={
                  dictation.status === "recording"
                    ? "Finish dictating"
                    : dictation.status === "transcribing"
                      ? "Transcribing"
                      : "Dictate a message"
                }
                aria-pressed={dictation.status === "recording"}
                className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                  dictation.status === "recording"
                    ? "bg-signal text-white hover:bg-signal-strong"
                    : "text-muted hover:text-ink"
                }`}
              >
                {dictation.status === "transcribing" ? (
                  <Meter state="live" tone="current" className="h-3.5" />
                ) : (
                  <Icon name="mic" className="h-4 w-4" />
                )}
              </button>
            )}
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
                disabled={!canSendNow}
                aria-label="Send message"
                className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                  canSendNow
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
          {dictation.status === "recording" ? (
            "Listening. Tap the mic when you're done."
          ) : dictation.status === "transcribing" ? (
            "Transcribing…"
          ) : dictation.status === "failed" ? (
            <>
              {dictation.message}{" "}
              {dictation.canRetry && (
                <button
                  type="button"
                  onClick={retry}
                  className="underline hover:text-ink"
                >
                  Try again
                </button>
              )}{" "}
              <button
                type="button"
                onClick={reset}
                className="underline hover:text-ink"
              >
                Dismiss
              </button>
            </>
          ) : (
            (blockedReason ?? "Enter sends · Shift+Enter for a new line")
          )}
        </p>
      </div>
    </div>
  );
}
