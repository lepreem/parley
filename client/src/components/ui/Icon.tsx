import type { ReactNode } from "react";

/** One stroke weight, one grid, so icons sit evenly next to Plex Sans text. */
const glyphs = {
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  send: <path d="M12 19V5M5 12l7-7 7 7" />,
  stop: (
    <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
  ),
  arrowDown: <path d="M12 5v14M19 12l-7 7-7-7" />,
  chevronDown: <path d="M6 9.5 12 15.5l6-6" />,
  check: <path d="M5 13l4 4L19 7" />,
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m4 17 4.5-4.5a2 2 0 0 1 2.83 0L16 17m-1-2.5 1.6-1.6a2 2 0 0 1 2.83 0L21 14.5" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11.5" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
    </>
  ),
  waveform: <path d="M4 10v4M8 6.5v11M12 3.5v17M16 7.5v9M20 10.5v3" />,
  video: (
    <>
      <rect x="3" y="6" width="12" height="12" rx="2" />
      <path d="m15 10.5 5.4-3.15a.5.5 0 0 1 .75.43v8.44a.5.5 0 0 1-.75.43L15 13.5" />
    </>
  ),
  youtube: (
    <>
      <rect x="2.5" y="5.5" width="19" height="13" rx="3.5" />
      <path d="m10.5 9.5 5 2.5-5 2.5z" />
    </>
  ),
  link: (
    <path d="M10.5 13.5a4.5 4.5 0 0 0 6.36 0l2.5-2.5a4.5 4.5 0 0 0-6.36-6.36l-1.2 1.2M13.5 10.5a4.5 4.5 0 0 0-6.36 0l-2.5 2.5a4.5 4.5 0 0 0 6.36 6.36l1.2-1.2" />
  ),
  library: <path d="M4 6h16M4 12h16M4 18h10" />,
  gauge: (
    <>
      <path d="M5.1 18.5a9 9 0 1 1 13.8 0" />
      <path d="m12 14 3.5-4.5" />
      <circle cx="12" cy="14" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.4 3.75 5.2 3.75 8.5S14.5 18.1 12 20.5C9.5 18.1 8.25 15.3 8.25 12S9.5 5.9 12 3.5z" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.75" />
    </>
  ),
  file: (
    <path d="M13.5 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5zM13.5 3.5V8.5h5" />
  ),
  spark: (
    <path d="M12 3.5l1.9 4.6L18.5 10l-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9zM18 16l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" />
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  trash: (
    <path d="M4 7h16M9 7V4.5h6V7M6.5 7l.9 12.1a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9L17.5 7M10 11v6M14 11v6" />
  ),
  pencil: (
    <path d="M4 20.5h4.2L20 8.7a2.4 2.4 0 1 0-3.4-3.4L4.8 17.1zM14.5 7.5l3 3" />
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15" />
    </>
  ),
  download: <path d="M12 4v11m-5-4.5 5 5 5-5M4.5 20h15" />,
  refresh: (
    <path d="M20 5.5v5h-5M4 18.5v-5h5M19.4 10.5a7.5 7.5 0 0 0-13-3.4M4.6 13.5a7.5 7.5 0 0 0 13 3.4" />
  ),
  panelLeft: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M10 4.5v15" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v1.5M12 19.5V21M21 12h-1.5M4.5 12H3m14.36 5.36-1.06-1.06M7.7 7.7 6.64 6.64m10.72 0L16.3 7.7M7.7 16.3l-1.06 1.06" />
    </>
  ),
  shield: <path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z" />,
  moon: <path d="M20.4 15.4A9 9 0 0 1 8.6 3.6a9 9 0 1 0 11.8 11.8z" />,
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5h.01" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof glyphs;

export function Icon({
  name,
  className = "w-5 h-5",
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {glyphs[name]}
    </svg>
  );
}
