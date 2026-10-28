import { describe, expect, it } from "vitest";
import {
  MAX_CONTEXT_CHARS,
  MAX_HISTORY_MESSAGES,
  admitHistory,
  countMessagesInContextWindow,
} from "../../src/chat/contextWindow";

function turn(name: string, contextCharCount: number, imageCount = 0) {
  return {
    name,
    contextCharCount,
    images: Array.from({ length: imageCount }, (_, i) => `${name}-image-${i}`),
  };
}

const tenth = MAX_CONTEXT_CHARS / 10;

describe("admitHistory", () => {
  it("admits turns newest first while they fit beside the new one", () => {
    const admitted = admitHistory(
      [
        turn("newest", 4 * tenth),
        turn("middle", 3 * tenth),
        turn("oldest", 3 * tenth),
      ],
      2 * tenth,
      0,
    );

    expect(admitted.map((t) => t.name)).toEqual(["newest", "middle"]);
  });

  it("stops at the first turn that doesn't fit, though an older one would", () => {
    const admitted = admitHistory(
      [turn("newest", tenth), turn("huge", 9 * tenth), turn("tiny", 1)],
      tenth,
      0,
    );

    expect(admitted.map((t) => t.name)).toEqual(["newest"]);
  });

  it("keeps nothing when the new turn fills the budget", () => {
    expect(admitHistory([turn("newest", 1)], MAX_CONTEXT_CHARS, 0)).toEqual([]);
  });

  it("caps replayed images newest first", () => {
    const admitted = admitHistory(
      [turn("newest", 1, 5), turn("middle", 1, 5), turn("oldest", 1, 2)],
      1,
      0,
    );

    expect(admitted.map((t) => t.images.length)).toEqual([5, 3, 0]);
    expect(admitted[1].images).toEqual([
      "middle-image-0",
      "middle-image-1",
      "middle-image-2",
    ]);
  });

  it("counts the new turn's images against the cap", () => {
    const admitted = admitHistory(
      [turn("newest", 1, 5), turn("oldest", 1, 2)],
      1,
      6,
    );

    expect(admitted.map((t) => t.images)).toEqual([
      ["newest-image-0", "newest-image-1"],
      [],
    ]);
  });
});

describe("countMessagesInContextWindow", () => {
  it("counts the newest messages that fit the budget", () => {
    expect(
      countMessagesInContextWindow([4 * tenth, 4 * tenth, 4 * tenth]),
    ).toBe(2);
  });

  it("never counts more than the history cap", () => {
    expect(
      countMessagesInContextWindow(Array(MAX_HISTORY_MESSAGES + 10).fill(1)),
    ).toBe(MAX_HISTORY_MESSAGES);
  });
});
