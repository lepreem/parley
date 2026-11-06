import { useState } from "react";
import type { PermissionMode } from "../../api/toolApprovals";
import { Icon } from "../ui/Icon";
import { useDismissable } from "../ui/useDismissable";

/** What each program on this computer may do, by what it means for the person. */
const OPTIONS: { mode: PermissionMode | null; label: string; hint: string }[] =
  [
    {
      mode: null,
      label: "Your settings",
      hint: "Asks whenever your Claude Code or Codex settings say to.",
    },
    {
      mode: "acceptEdits",
      label: "Allow edits",
      hint: "Edits files without asking; asks before anything else.",
    },
    {
      mode: "bypassPermissions",
      label: "Allow all",
      hint: "Runs anything without asking, with nothing sandboxed.",
    },
  ];

export function PermissionPicker({
  value,
  onChange,
}: {
  /** Null leaves it to the person's own settings. */
  value: PermissionMode | null;
  onChange: (mode: PermissionMode | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useDismissable<HTMLDivElement>(open, () => setOpen(false));
  const current = OPTIONS.find((option) => option.mode === value) ?? OPTIONS[0];
  const allowsAll = value === "bypassPermissions";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((isOpen) => !isOpen)}
        aria-label="Choose what chats may do without asking"
        aria-expanded={open}
        className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] transition-colors hover:bg-sunk ${
          allowsAll ? "text-live" : "text-muted hover:text-ink"
        }`}
      >
        <Icon name="shield" className="h-4 w-4 shrink-0" />
        <span className="truncate">{current?.label}</span>
        <Icon name="chevronDown" className="h-3.5 w-3.5 shrink-0" />
      </button>

      {open && (
        <div
          ref={menuRef}
          className="absolute bottom-10 left-0 z-30 w-64 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-xl"
        >
          {OPTIONS.map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={() => {
                onChange(option.mode);
                setOpen(false);
              }}
              className="flex w-full items-start justify-between gap-3 px-3 py-1.5 text-left transition-colors hover:bg-sunk"
            >
              <span>
                <span className="block text-[12px] text-ink">
                  {option.label}
                </span>
                <span className="block text-[11px] text-faint">
                  {option.hint}
                </span>
              </span>
              {option.mode === value && (
                <Icon name="check" className="h-4 w-4 shrink-0 text-signal" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
