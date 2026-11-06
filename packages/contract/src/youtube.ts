const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

/** Every YouTube video id: eleven characters of base64url. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Path prefixes that put the video id in the next path segment. */
const ID_PATH_PREFIXES = new Set(["shorts", "live", "embed", "v"]);

/**
 * The id of the video a YouTube URL points at, or null when it isn't one
 * video's: a channel, a playlist, or not YouTube at all. Every way of linking
 * the same video gives the same id, so it's what a video is known by. Both
 * servers accept a YouTube upload by it, and the client offers one by it as
 * soon as a link is typed.
 */
export function youtubeVideoId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!YOUTUBE_HOSTS.has(url.hostname)) return null;

  const [first, second] = url.pathname.split("/").filter(Boolean);
  const id =
    url.hostname === "youtu.be"
      ? first
      : first === "watch"
        ? url.searchParams.get("v")
        : first && ID_PATH_PREFIXES.has(first)
          ? second
          : null;

  return id && VIDEO_ID.test(id) ? id : null;
}

/** The plain watch URL for a video id, with nothing else on it. */
export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
