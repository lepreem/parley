import { useToast } from "../../hooks/toast/useToast";
import type { ToastKind } from "../../hooks/toast/context";
import { Icon, type IconName } from "../ui/Icon";

const kindIcons: Record<ToastKind, IconName> = {
  success: "check",
  error: "alert",
  info: "alert",
};

const kindColors: Record<ToastKind, string> = {
  success: "text-signal-ink",
  error: "text-live",
  info: "text-muted",
};

export function Toaster() {
  const { toasts, dismiss } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex w-80 max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className="flex items-start gap-2.5 rounded-lg border border-line bg-surface p-3 shadow-lg"
        >
          <Icon
            name={kindIcons[toast.kind]}
            className={`mt-0.5 h-4 w-4 shrink-0 ${kindColors[toast.kind]}`}
          />
          <p className="flex-1 text-[13px] leading-snug">{toast.message}</p>
          <button
            type="button"
            onClick={() => dismiss(toast.id)}
            aria-label="Dismiss"
            className="shrink-0 rounded-md p-0.5 text-faint transition-colors hover:text-ink"
          >
            <Icon name="close" className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
