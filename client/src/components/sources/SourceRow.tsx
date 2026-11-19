import { useState } from "react";
import type { JobSummary } from "../../api/jobs";
import { startSourceDrag } from "../../sources/sourceDrag";
import { Icon } from "../ui/Icon";
import { Meter, type MeterState } from "../ui/Meter";
import { useDismissable } from "../ui/useDismissable";

const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function meterState(status: JobSummary["status"]): MeterState {
  if (status === "failed") return "failed";
  if (status === "completed") return "ready";
  return "live";
}

type SourceRowProps = {
  job: JobSummary;
  onOpen: () => void;
  onAttach: () => void;
  onDelete: () => void;
  /** A ready row can be dragged onto the chat; this reports when it lifts and lands. */
  onDragChange: (dragging: boolean) => void;
};

export function SourceRow({
  job,
  onOpen,
  onAttach,
  onDelete,
  onDragChange,
}: SourceRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useDismissable<HTMLDivElement>(menuOpen, () =>
    setMenuOpen(false),
  );
  const ready = job.status === "completed";

  return (
    <li
      draggable={ready}
      onDragStart={(event) => {
        startSourceDrag(event.dataTransfer, {
          audioUploadId: job.audioUploadId,
          fileName: job.fileName,
          source: job.source,
        });
        setMenuOpen(false);
        onDragChange(true);
      }}
      onDragEnd={() => onDragChange(false)}
      className={`relative border-b border-line last:border-b-0 ${ready ? "cursor-grab active:cursor-grabbing" : ""}`}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <Meter state={meterState(job.status)} className="mt-0.5 shrink-0" />

        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate font-mono text-[12px] text-ink">
            {job.fileName}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-faint">
            {job.status === "failed"
              ? (job.error ?? "failed")
              : `${job.status} · ${dateFormat.format(new Date(job.createdAt))}`}
          </span>
        </button>

        {ready && (
          <button
            type="button"
            onClick={onAttach}
            className="shrink-0 rounded-md border border-line px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:border-signal hover:text-ink"
          >
            Attach
          </button>
        )}

        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={`Actions for ${job.fileName}`}
          aria-expanded={menuOpen}
          className="shrink-0 rounded-md p-1 text-faint transition-colors hover:bg-sunk hover:text-ink"
        >
          <Icon name="more" className="h-4 w-4" />
        </button>
      </div>

      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute right-3 top-12 z-30 w-48 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-lg"
        >
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              onDelete();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-live transition-colors hover:bg-live-tint"
          >
            <Icon name="trash" className="h-4 w-4" />
            Delete
          </button>
        </div>
      )}
    </li>
  );
}
