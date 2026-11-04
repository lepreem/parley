import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, access } from "node:fs/promises";
import path from "node:path";

/** yt-dlp as this platform names it. */
export function ytDlpName(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

/**
 * yt-dlp's path, in the data folder rather than inside the app. YouTube changes
 * often enough that an old yt-dlp is a broken one, so it replaces itself with
 * new releases, which it couldn't do inside an installed app. The copy that
 * ships with the app is only the first one.
 */
export async function installYtDlp(
  bundledDir: string,
  dataDir: string,
): Promise<string> {
  const name = ytDlpName();
  const target = path.join(dataDir, "bin", name);
  try {
    await access(target);
    return target;
  } catch {
    // First launch.
  }
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(bundledDir, name), target);
  await chmod(target, 0o755);
  if (process.platform === "darwin") {
    // A copy keeps the download's quarantine mark, which would stop it running
    // now that it's outside the app the person agreed to open.
    await new Promise<void>((resolve) => {
      execFile("/usr/bin/xattr", ["-d", "com.apple.quarantine", target], () =>
        resolve(),
      );
    });
  }
  return target;
}

/**
 * Asks yt-dlp to update itself, leaving it as it is if it can't: yt-dlp checks
 * what it downloads against its release's signature, and failing is only a
 * sign of being offline.
 */
export function updateYtDlp(ytDlpPath: string): void {
  execFile(
    ytDlpPath,
    ["--update"],
    { timeout: 5 * 60_000, windowsHide: true },
    () => {},
  );
}
