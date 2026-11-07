import path from "node:path";

/** yt-dlp as this platform names it. */
export function ytDlpName(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

/**
 * The yt-dlp the app ships, run from inside the app. It changes only when the
 * person installs a new Parley, never by itself: a new yt-dlp is new code on
 * their computer, so it waits for them to choose the update. That also means a
 * YouTube change that breaks it stays broken until Parley ships the fix. The
 * version is pinned in scripts/stage.mts.
 */
export function bundledYtDlp(bundledDir: string): string {
  return path.join(bundledDir, ytDlpName());
}
