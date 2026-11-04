import { Link } from "react-router-dom";
import { DESKTOP_APP_LINK } from "../../lib/openDesktopApp";

const RELEASES = "https://github.com/lepreem/parley/releases/latest/download";

type Platform = "mac" | "windows" | "linux";

type Download = { label: string; file: string };

const DOWNLOADS: Record<Platform, Download[]> = {
  mac: [
    { label: "Mac with Apple silicon", file: "Parley-mac-arm64.dmg" },
    { label: "Mac with Intel", file: "Parley-mac-x64.dmg" },
  ],
  windows: [{ label: "Windows", file: "Parley-windows-x64.exe" }],
  linux: [
    { label: "Linux .deb", file: "Parley-linux-amd64.deb" },
    { label: "Linux .deb (ARM)", file: "Parley-linux-arm64.deb" },
    { label: "Linux AppImage", file: "Parley-linux-x86_64.AppImage" },
    { label: "Linux AppImage (ARM)", file: "Parley-linux-arm64.AppImage" },
  ],
};

/** What installing takes, including the warning an unsigned app gets once. */
const STEPS: Record<Platform, string[]> = {
  mac: [
    "Open the download and drag Parley to Applications.",
    "Open Parley. macOS says it can't check the app; click Done.",
    "Go to System Settings → Privacy & Security, scroll down and click Open Anyway. You only do this once.",
  ],
  windows: [
    "Run the download.",
    "If Windows SmartScreen appears, click More info, then Run anyway. You only do this once.",
  ],
  linux: [
    "Install the .deb with your software installer, or make the AppImage executable and run it.",
  ],
};

const PLATFORM_NAMES: Record<Platform, string> = {
  mac: "macOS",
  windows: "Windows",
  linux: "Linux",
};

function detectPlatform(userAgent: string): Platform {
  if (/windows/i.test(userAgent)) return "windows";
  if (/macintosh|mac os/i.test(userAgent)) return "mac";
  return "linux";
}

function PlatformDownloads({
  platform,
  featured,
}: {
  platform: Platform;
  featured: boolean;
}) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5 text-left">
      <h2 className="text-sm font-semibold">{PLATFORM_NAMES[platform]}</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {DOWNLOADS[platform].map(({ label, file }) => (
          <a
            key={file}
            href={`${RELEASES}/${file}`}
            className={
              featured
                ? "inline-flex items-center rounded-lg bg-signal px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                : "inline-flex items-center rounded-lg border border-line px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-signal hover:text-ink"
            }
          >
            {label}
          </a>
        ))}
      </div>
      {featured && (
        <ol className="mt-4 list-decimal space-y-1 pl-5 text-[13px] leading-relaxed text-muted">
          {STEPS[platform].map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Where "Use this computer" leads when the app isn't installed. On this
 * computer, chats go through the person's own Claude Code and audio is
 * transcribed locally, which takes an app rather than a website.
 */
export function DownloadPage() {
  const current = detectPlatform(navigator.userAgent);
  const others = (["mac", "windows", "linux"] as const).filter(
    (platform) => platform !== current,
  );
  const terminal =
    current === "windows"
      ? `irm ${window.location.origin}/install.ps1 | iex`
      : `curl -fsSL ${window.location.origin}/install.sh | sh`;

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <header className="flex h-14 shrink-0 items-center px-5">
        <Link to="/" className="eyebrow text-ink">
          Parley
        </Link>
      </header>

      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 px-5 py-10">
        <div className="mb-2 text-center">
          <h1 className="text-3xl font-semibold tracking-tight">
            Parley on your computer
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-muted">
            Chats run on your own Claude Code and recordings are transcribed on
            your machine, without an account here. If you don't have Claude Code
            yet, the app sets it up.
          </p>
          <a
            href={DESKTOP_APP_LINK}
            className="mt-3 inline-block text-sm text-signal-strong hover:underline"
          >
            Already installed? Open Parley
          </a>
        </div>

        <PlatformDownloads platform={current} featured />

        <section className="rounded-2xl border border-line bg-surface p-5 text-left">
          <h2 className="text-sm font-semibold">Or from a terminal</h2>
          <code className="mt-2 block overflow-x-auto font-mono text-[12px] text-muted">
            {terminal}
          </code>
        </section>

        {others.map((platform) => (
          <PlatformDownloads
            key={platform}
            platform={platform}
            featured={false}
          />
        ))}
      </main>
    </div>
  );
}
