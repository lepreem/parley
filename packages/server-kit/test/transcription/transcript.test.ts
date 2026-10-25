import { describe, expect, it } from "vitest";
import {
  formatTimestamp,
  paragraphsOf,
  transcriptText,
} from "@parley/server-kit/transcription/transcript";

describe("formatTimestamp", () => {
  it("writes minutes and seconds under an hour, and hours past one", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(65.9)).toBe("1:05");
    expect(formatTimestamp(3723)).toBe("1:02:03");
  });
});

describe("paragraphsOf", () => {
  it("joins segments until a long enough pause", () => {
    expect(
      paragraphsOf([
        { start: 0, end: 1, text: " Hello" },
        { start: 1.5, end: 2, text: "there." },
        { start: 5, end: 6, text: "Next." },
      ]),
    ).toEqual([
      { start: 0, end: 2, text: "Hello there." },
      { start: 5, end: 6, text: "Next." },
    ]);
  });

  it("ends a long paragraph at a sentence end", () => {
    const sentence = "word ".repeat(100).trim() + ".";
    const paragraphs = paragraphsOf([
      { start: 0, end: 30, text: sentence },
      { start: 30, end: 31, text: "after" },
    ]);
    expect(paragraphs.map((paragraph) => paragraph.start)).toEqual([0, 30]);
  });

  it("ends an unpunctuated paragraph once it's far too long", () => {
    const words = Array.from({ length: 400 }, (_, i) => ({
      start: i,
      end: i + 1,
      text: "word",
    }));
    const paragraphs = paragraphsOf(words);
    expect(paragraphs.length).toBeGreaterThan(1);
    expect(
      paragraphs.every((paragraph) => paragraph.text.length <= 1_005),
    ).toBe(true);
  });

  it("drops segments with no text", () => {
    expect(paragraphsOf([{ start: 0, end: 1, text: "  " }])).toEqual([]);
  });
});

describe("transcriptText", () => {
  it("starts each paragraph with when it was said", () => {
    expect(
      transcriptText([
        { start: 0, end: 1, text: "First." },
        { start: 125, end: 126, text: "Second." },
      ]),
    ).toBe("[0:00] First.\n\n[2:05] Second.");
  });

  it("is empty when nothing was said", () => {
    expect(transcriptText([])).toBe("");
  });
});
