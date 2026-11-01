import { useRef, useState, type ChangeEvent } from "react";
import { useServerReady } from "../../hooks/server/useServerReady";
import { useTranscriptionModelsQuery } from "../../hooks/queries/useModelsQuery";
import { IMAGE_ACCEPT, MEDIA_ACCEPT } from "../../media/fileKind";
import { Icon } from "../ui/Icon";
import { useDismissable } from "../ui/useDismissable";

type AttachMenuProps = {
  onAddFiles: (files: File[]) => void;
  onBrowseSources: () => void;
  transcriptModelId: string | null;
  onTranscriptModelChange: (modelId: string) => void;
  useCaptionsIfAvailable: boolean;
  onUseCaptionsChange: (use: boolean) => void;
};

export function AttachMenu({
  onAddFiles,
  onBrowseSources,
  transcriptModelId,
  onTranscriptModelChange,
  useCaptionsIfAvailable,
  onUseCaptionsChange,
}: AttachMenuProps) {
  const ready = useServerReady();
  const { models: transcriptionModels } = useTranscriptionModelsQuery(ready);
  const [open, setOpen] = useState(false);
  const menuRef = useDismissable<HTMLDivElement>(open, () => setOpen(false));
  const imageInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);

  const handlePicked = (event: ChangeEvent<HTMLInputElement>) => {
    onAddFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
    setOpen(false);
  };

  return (
    <div className="relative">
      <input
        ref={imageInputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        onChange={handlePicked}
        className="sr-only"
        tabIndex={-1}
      />
      <input
        ref={mediaInputRef}
        type="file"
        accept={MEDIA_ACCEPT}
        multiple
        onChange={handlePicked}
        className="sr-only"
        tabIndex={-1}
      />

      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label="Add a source"
        aria-expanded={open}
        className="rounded-lg p-2 text-muted transition-colors hover:bg-sunk hover:text-ink"
      >
        <Icon name="plus" className="h-5 w-5" />
      </button>

      {open && (
        <div
          ref={menuRef}
          className="absolute bottom-12 left-0 z-30 w-64 overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
        >
          <button
            type="button"
            onClick={() => imageInputRef.current?.click()}
            className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-sunk"
          >
            <Icon name="image" className="h-4 w-4 text-muted" />
            Photos
          </button>
          <button
            type="button"
            onClick={() => mediaInputRef.current?.click()}
            className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-sunk"
          >
            <Icon name="waveform" className="h-4 w-4 text-muted" />
            Audio or video
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onBrowseSources();
            }}
            className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-sunk"
          >
            <Icon name="library" className="h-4 w-4 text-muted" />
            Browse sources…
          </button>

          <div className="border-t border-line px-3 py-2.5">
            <label
              htmlFor="transcription-model"
              className="eyebrow block pb-1.5 text-faint"
            >
              Transcribe with
            </label>
            <select
              id="transcription-model"
              value={transcriptModelId ?? ""}
              onChange={(event) => onTranscriptModelChange(event.target.value)}
              className="w-full rounded-md border border-line bg-canvas px-2 py-1.5 font-mono text-[11px] text-ink outline-none"
            >
              {transcriptionModels.length === 0 ? (
                <option value="">Loading…</option>
              ) : (
                transcriptionModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))
              )}
            </select>
            <label className="flex items-start gap-2 pt-2 text-xs text-ink">
              <input
                type="checkbox"
                checked={useCaptionsIfAvailable}
                onChange={(event) => onUseCaptionsChange(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                Use YouTube captions when a video has them
                <span className="block text-[11px] leading-snug text-faint">
                  Instant, but rougher than transcribing.
                </span>
              </span>
            </label>
            <p className="pt-1.5 text-[11px] leading-snug text-faint">
              Applies to sources you add from now on.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
