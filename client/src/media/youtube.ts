import { youtubeVideoId } from "@parley/contract/youtube";

/** The last link to a YouTube video in what the user has typed, or null. */
export function findYoutubeUrl(text: string): string | null {
  const candidates = text.match(/https?:\/\/[^\s<>"']+/gi);
  if (!candidates) return null;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    // Trailing punctuation is far more likely sentence than URL.
    const candidate = candidates[index].replace(/[.,;:!?)\]]+$/, "");
    if (youtubeVideoId(candidate)) return candidate;
  }
  return null;
}

/** The video id, for a label short enough to sit in one line of chrome. */
export function youtubeLabel(url: string): string {
  const id = youtubeVideoId(url);
  return id ? `youtube/${id}` : url;
}

/** Where to embed a video. The no-cookie host sets no cookies until it's played. */
export function youtubeEmbedUrl(videoId: string): string {
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}`;
}
