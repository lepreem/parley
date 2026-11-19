import { Meter } from "../ui/Meter";

/** Files off the computer, or a finished source out of the library. */
export type DragKind = "files" | "library";

export function DropOverlay({ kind }: { kind: DragKind }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-canvas/85">
      <div className="rounded-2xl border-2 border-dashed border-signal px-10 py-8 text-center">
        <Meter state="live" className="mx-auto h-5" />
        <p className="mt-3 text-sm font-medium">Drop to add a source</p>
        <p className="eyebrow mt-1.5 text-faint">
          {kind === "library"
            ? "already transcribed"
            : "audio · video · images"}
        </p>
      </div>
    </div>
  );
}
