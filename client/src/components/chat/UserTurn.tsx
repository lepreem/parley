import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { MessageTranscript } from "../../api/messages";
import { Icon } from "../ui/Icon";
import { useShell } from "../app/shellContext";
import { TurnSources } from "./TurnSources";
import type { TurnImage } from "./types";
import { buttonClass } from "../ui/buttonClass";

/**
 * Rewriting a sent message in place. Saving replaces it and every turn after
 * it, so the editor says so rather than letting it come as a surprise.
 */
function TurnEditor({
  initialContent,
  canSave,
  onSave,
  onCancel,
}: {
  initialContent: string;
  canSave: boolean;
  onSave: (content: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialContent);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const content = draft.trim();
  const saveable = canSave && content.length > 0;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  // Grows with what's typed, like the composer, up to its own cap.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (saveable) onSave(content);
    }
  };

  return (
    <div className="w-full">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        aria-label="Edit message"
        rows={1}
        className="block max-h-60 w-full resize-none bg-transparent text-[0.9375rem] leading-relaxed outline-none"
      />
      <div className="mt-3 flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-faint">
          Replaces this message and everything after it.
        </span>
        <button
          type="button"
          onClick={onCancel}
          className={buttonClass("quiet", "sm")}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onSave(content)}
          disabled={!saveable}
          className={buttonClass("primary", "sm")}
        >
          Send
        </button>
      </div>
    </div>
  );
}

export function UserTurn({
  content,
  images,
  transcripts,
  onEdit,
  canEdit = false,
}: {
  content: string;
  images: TurnImage[];
  transcripts: MessageTranscript[];
  /** Offered on stored messages: replaces this turn and what follows it. */
  onEdit?: (content: string) => void;
  /** False while another turn in this chat is still being answered. */
  canEdit?: boolean;
}) {
  const { setOpenSource } = useShell();
  const [editing, setEditing] = useState(false);

  return (
    <div className="group/turn flex flex-col items-end">
      <TurnSources transcripts={transcripts} />

      <div
        className={`rounded-2xl rounded-br-md border bg-surface px-4 py-3 ${
          editing
            ? "w-full max-w-[85%] border-signal"
            : "max-w-[85%] border-line"
        }`}
      >
        {images.length > 0 && (
          <div
            className={`mb-3 grid gap-2 ${images.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}
          >
            {images.map((image) => (
              <button
                key={image.imageUploadId}
                type="button"
                onClick={() =>
                  setOpenSource({
                    kind: "image",
                    url: image.url,
                    fileName: image.fileName,
                  })
                }
                aria-label={`View ${image.fileName}`}
                className="block overflow-hidden rounded-lg border border-line transition-colors hover:border-signal"
              >
                <img
                  src={image.url}
                  alt={image.fileName}
                  className="h-28 w-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
        {editing && onEdit ? (
          <TurnEditor
            initialContent={content}
            canSave={canEdit}
            onSave={(edited) => {
              setEditing(false);
              onEdit(edited);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <p className="whitespace-pre-wrap text-[0.9375rem] leading-relaxed">
            {content}
          </p>
        )}
      </div>

      {onEdit && !editing && (
        <div className="mt-1 flex h-7 items-center">
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={!canEdit}
            aria-label="Edit message"
            title="Edit message"
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-muted opacity-0 pointer-coarse:opacity-100 transition-opacity hover:text-ink focus-visible:opacity-100 disabled:hidden group-hover/turn:opacity-100"
          >
            <Icon name="pencil" className="h-3.5 w-3.5" />
            <span className="text-xs">Edit</span>
          </button>
        </div>
      )}
    </div>
  );
}
