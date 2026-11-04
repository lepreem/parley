const LATEST_RELEASE =
  "https://api.github.com/repos/lepreem/parley/releases/latest";

/** Whether version `a` is newer than `b`, comparing dotted numbers. */
export function isNewer(a: string, b: string): boolean {
  const parse = (version: string) =>
    version.replace(/^v/, "").split(".").map(Number);
  const [left, right] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const [x, y] = [left[i] ?? 0, right[i] ?? 0];
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * The newest release, if it's newer than `current`. Without paying for a Mac
 * signing certificate the app can't replace itself there, so every platform
 * gets the same thing: being told, and a link. Failing means offline or
 * rate-limited, and says nothing worth interrupting anyone for.
 */
export async function newerRelease(
  current: string,
): Promise<{ version: string; url: string } | undefined> {
  try {
    const response = await fetch(LATEST_RELEASE, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return undefined;
    const { tag_name: version, html_url: url } = (await response.json()) as {
      tag_name: string;
      html_url: string;
    };
    return isNewer(version, current) ? { version, url } : undefined;
  } catch {
    return undefined;
  }
}
