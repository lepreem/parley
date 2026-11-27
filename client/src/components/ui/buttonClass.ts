/**
 * The app's buttons, as class names so a <button>, <a> or <Link> can all wear
 * them. Every theme sets the tokens these read, so a button looks right in
 * each without its own colours.
 */

const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg transition-colors motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50";

const VARIANTS = {
  /** The one thing to do here. */
  primary:
    "bg-signal font-semibold text-on-signal hover:bg-signal-strong disabled:hover:bg-signal",
  /** Another way forward, beside a primary. */
  secondary:
    "border border-line bg-surface font-medium text-ink hover:border-line-strong hover:bg-sunk",
  /** Cancel, Not now: no fill until hovered. */
  quiet: "font-medium text-muted hover:bg-sunk hover:text-ink",
  /** Can't be undone. */
  danger:
    "bg-live font-semibold text-on-live hover:opacity-90 disabled:hover:opacity-50",
} as const;

const SIZES = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-3 py-1.5 text-sm",
  lg: "px-5 py-2.5 text-sm",
} as const;

export function buttonClass(
  variant: keyof typeof VARIANTS,
  size: keyof typeof SIZES = "md",
): string {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]}`;
}
