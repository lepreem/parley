import { describe, expect, it } from "vitest";
import { youtubeVideoId, youtubeWatchUrl } from "@parley/contract/youtube";

const ID = "dQw4w9WgXcQ";

describe("youtubeVideoId", () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&list=PL123&t=90`,
    `https://m.youtube.com/watch?feature=share&v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc&t=12`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}?feature=share`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/v/${ID}`,
  ])("finds the video in %s", (url) => {
    expect(youtubeVideoId(url)).toBe(ID);
  });

  it.each([
    "https://www.youtube.com/",
    "https://www.youtube.com/@somechannel",
    "https://www.youtube.com/playlist?list=PL123",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?v=short",
    `https://www.youtube.com/watch?v=${ID}x`,
    "https://youtu.be/",
    `https://example.com/watch?v=${ID}`,
    `https://notyoutube.com/watch?v=${ID}`,
    "not a url",
  ])("finds no video in %s", (url) => {
    expect(youtubeVideoId(url)).toBeNull();
  });

  it("turns the id back into a watch URL that parses to it", () => {
    expect(youtubeVideoId(youtubeWatchUrl(ID))).toBe(ID);
  });
});
