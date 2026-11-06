import { useState } from "react";
import type { ChatModel, ReasoningEffort } from "../../api/models";
import { Icon } from "../ui/Icon";
import { useDismissable } from "../ui/useDismissable";

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "No thinking",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

type EffortPickerProps = {
  /** The chosen model's levels. Nothing shows when it has none to choose. */
  reasoning: ChatModel["reasoning"];
  /** Null leaves it to the model. */
  value: ReasoningEffort | null;
  onChange: (effort: ReasoningEffort | null) => void;
};

export function EffortPicker({
  reasoning,
  value,
  onChange,
}: EffortPickerProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useDismissable<HTMLDivElement>(open, () => setOpen(false));

  if (!reasoning) return null;

  const { defaultEffort } = reasoning;
  // What the model will actually use: no pick means its default.
  const current = value ?? defaultEffort;

  const option = (label: string, effort: ReasoningEffort | null) => (
    <button
      key={label}
      type="button"
      onClick={() => {
        // The default level clears the pick, so the next model chosen starts
        // on its own default rather than inheriting this one's.
        onChange(effort === defaultEffort ? null : effort);
        setOpen(false);
      }}
      className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-sunk"
    >
      <span className="truncate">{label}</span>
      {effort === current && (
        <Icon name="check" className="h-4 w-4 shrink-0 text-signal" />
      )}
    </button>
  );

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((isOpen) => !isOpen)}
        aria-label="Choose how hard the model thinks"
        aria-expanded={open}
        className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] text-muted transition-colors hover:bg-sunk hover:text-ink"
      >
        <Icon name="gauge" className="h-4 w-4 shrink-0" />
        <span className="truncate">
          {current ? EFFORT_LABELS[current] : "Default"}
        </span>
        <Icon name="chevronDown" className="h-3.5 w-3.5 shrink-0" />
      </button>

      {open && (
        <div
          ref={menuRef}
          className="absolute bottom-10 left-0 z-30 w-48 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-xl"
        >
          {/* A model that doesn't say what its default is has no level to mark. */}
          {!defaultEffort && option("Default", null)}
          {reasoning.efforts.map((effort) =>
            option(
              effort === defaultEffort
                ? `${EFFORT_LABELS[effort]} (default)`
                : EFFORT_LABELS[effort],
              effort,
            ),
          )}
          <p className="border-t border-line px-3 pb-1 pt-2 text-[11px] text-faint">
            More effort takes longer and uses more.
          </p>
        </div>
      )}
    </div>
  );
}
