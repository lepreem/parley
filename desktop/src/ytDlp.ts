import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { isNewer } from "./updates";

const RELEASES =
  "https://api.github.com/repos/yt-dlp/yt-dlp/releases?per_page=30";
const SETTLE_MS = 7 * 24 * 60 * 60 * 1000;

/** yt-dlp as this platform names it. */
export function ytDlpName(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

/**
 * yt-dlp's path, in the data folder rather than inside the app. YouTube changes
 * often enough that an old yt-dlp is a broken one, so it moves itself to
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

type Release = {
  tag_name: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
};

/**
 * The newest release that has been out for at least a week. yt-dlp's updater
 * only checks a download against a checksum from the same release, so someone
 * who could replace a release could run anything on this computer. A week gives
 * people time to notice, and costs a YouTube fix a few days at worst.
 */
export function settledRelease(
  releases: readonly Release[],
  now: number = Date.now(),
): string | undefined {
  return releases
    .filter(({ draft, prerelease, published_at: published }) => {
      if (draft || prerelease || !published) return false;
      return now - Date.parse(published) >= SETTLE_MS;
    })
    .toSorted(
      (a, b) =>
        Date.parse(b.published_at ?? "") - Date.parse(a.published_at ?? ""),
    )[0]?.tag_name;
}

function run(program: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      { timeout: 5 * 60_000, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/**
 * Moves yt-dlp up to the newest settled release, if that's newer than what it
 * is, and otherwise leaves it as it is. Failing is only a sign of being offline.
 */
export async function updateYtDlp(ytDlpPath: string): Promise<void> {
  try {
    const response = await fetch(RELEASES, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return;
    const tag = settledRelease((await response.json()) as Release[]);
    if (!tag) return;
    const current = (await run(ytDlpPath, ["--version"])).trim();
    if (isNewer(tag, current)) {
      await run(ytDlpPath, ["--update-to", `stable@${tag}`]);
    }
  } catch {
    // Still the version it was.
  }
}
