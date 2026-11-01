import { useEffect, useRef, useState } from "react";
import { useJobQuery } from "../../hooks/queries/useJobQueries";
import { useToast } from "../../hooks/toast/useToast";
import { downloadTextFile, resultFileName } from "../../lib/download";
import { useSources } from "../../sources/useSources";
import { useShell } from "../app/shellContext";
import { Icon } from "../ui/Icon";
import { Meter } from "../ui/Meter";
import { SourcePlayback } from "./SourcePlayback";
import { useDraftKey } from "./useDraftKey";

function TranscriptBody({
  audioUploadId,
  onClose,
}: {
  audioUploadId: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const draftKey = useDraftKey();
  const { sources, attachExisting } = useSources(draftKey);
  const jobQuery = useJobQuery(audioUploadId);
  const [copied, setCopied] = useState(false);
  const job = jobQuery.data;

  if (jobQuery.isLoading) {
    return <p className="p-5 text-sm text-faint">Loading transcript…</p>;
  }
  if (jobQuery.error || !job) {
    return (
      <p className="p-5 text-sm text-live">This source couldn't be loaded.</p>
    );
  }

  const ready = job.status === "completed" && !!job.transcript;
  const alreadyStaged = sources.some(
    (source) => source.sourceUploadId === audioUploadId,
  );

  const copy = async () => {
    if (!job.transcript) return;
    await navigator.clipboard.writeText(job.transcript);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const attach = () => {
    attachExisting({
      audioUploadId,
      fileName: job.fileName,
      source: job.source,
    });
    toast.show({
      kind: "success",
      message: `${job.fileName} added to the message.`,
    });
    onClose();
  };

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-2.5">
        <Meter
          state={
            job.status === "failed"
              ? "failed"
              : job.status === "completed"
                ? "ready"
                : "live"
          }
        />
        <span className="text-[11px] text-faint">
          {ready
            ? `${job.transcript?.length.toLocaleString()} chars`
            : job.status}
        </span>
        <span className="flex-1" />
        {ready && (
          <>
            {!alreadyStaged && (
              <button
                type="button"
                onClick={attach}
                className="rounded-md border border-line px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:border-signal hover:text-ink"
              >
                Attach
              </button>
            )}
            <button
              type="button"
              onClick={() => void copy()}
              aria-label={copied ? "Transcript copied" : "Copy transcript"}
              className="rounded-md p-1.5 text-muted transition-colors hover:bg-sunk hover:text-ink"
            >
              <Icon name={copied ? "check" : "copy"} className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() =>
                downloadTextFile(
                  resultFileName(job.fileName, "transcript"),
                  job.transcript ?? "",
                )
              }
              aria-label="Download transcript"
              className="rounded-md p-1.5 text-muted transition-colors hover:bg-sunk hover:text-ink"
            >
              <Icon name="download" className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      <SourcePlayback key={job.audioUploadId} job={job} />

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {job.status === "failed" ? (
          <p className="text-sm text-live">
            {job.error ?? "This transcription failed."}
          </p>
        ) : job.transcript ? (
          <p className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed">
            {job.transcript}
          </p>
        ) : (
          <p className="text-sm text-faint">
            Still working — the transcript appears here when it lands.
          </p>
        )}
      </div>
    </>
  );
}

/**
 * One window for reading a source, wherever it was opened from: a chip in the
 * composer, a chip on a sent turn, or a row in the sources drawer.
 */
export function SourceDialog() {
  const { openSource, setOpenSource } = useShell();
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!openSource) return;
    restoreFocusRef.current = document.activeElement;
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpenSource(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (restoreFocusRef.current instanceof HTMLElement) {
        restoreFocusRef.current.focus();
      }
    };
  }, [openSource, setOpenSource]);

  if (!openSource) return null;

  const close = () => setOpenSource(null);
  const title = openSource.fileName;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-5">
          <p className="min-w-0 flex-1 truncate font-mono text-[12px]">
            {title}
          </p>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            aria-label="Close"
            className="rounded-lg p-2 text-muted transition-colors hover:bg-sunk hover:text-ink"
          >
            <Icon name="close" className="h-4 w-4" />
          </button>
        </div>

        {openSource.kind === "image" ? (
          <div className="min-h-0 flex-1 overflow-auto bg-sunk p-4">
            <img
              src={openSource.url}
              alt={openSource.fileName}
              className="mx-auto max-w-full rounded-lg"
            />
          </div>
        ) : (
          <TranscriptBody
            audioUploadId={openSource.audioUploadId}
            onClose={close}
          />
        )}
      </div>
    </div>
  );
}
