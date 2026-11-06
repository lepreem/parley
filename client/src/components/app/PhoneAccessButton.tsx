import { useEffect, useState } from "react";
import { Icon } from "../ui/Icon";

type PhoneSummary = "off" | "on" | "attention";

/** What the desktop app's window adds to the page. Nothing else has it. */
declare global {
  interface Window {
    parleyDesktop?: {
      openPhoneAccess(): Promise<void>;
      phoneSummary(): Promise<PhoneSummary>;
      onPhoneSummary(listener: (summary: PhoneSummary) => void): () => void;
    };
  }
}

const LABELS: Record<PhoneSummary, string> = {
  off: "Use from your phone",
  on: "Phone access is on",
  attention: "Phone access needs a look",
};

/**
 * Opens the desktop app's phone access window. Only there: a phone, or the
 * hosted site, has no desktop app to ask.
 */
export function PhoneAccessButton() {
  const desktop = window.parleyDesktop;
  const [summary, setSummary] = useState<PhoneSummary>("off");

  useEffect(() => {
    if (!desktop) return;
    void desktop.phoneSummary().then(setSummary);
    return desktop.onPhoneSummary(setSummary);
  }, [desktop]);

  if (!desktop) return null;
  return (
    <button
      type="button"
      onClick={() => void desktop.openPhoneAccess()}
      className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-muted transition-colors hover:bg-surface hover:text-ink"
    >
      <Icon name="phone" className="h-4 w-4" />
      {LABELS[summary]}
    </button>
  );
}
