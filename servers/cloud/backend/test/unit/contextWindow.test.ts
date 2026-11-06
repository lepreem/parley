import { describe, expect, it } from "vitest";
import {
  MAX_CONTEXT_CHARS,
  MAX_HISTORY_MESSAGES,
  admitHistory,
  completionTokenCeiling,
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

describe("completionTokenCeiling", () => {
  const offering = (defaultEffort: "low" | null) => ({
    maxOutputTokens: null,
    reasoning: { efforts: ["none" as const, "low" as const], defaultEffort },
  });

  it("makes room for the thinking the chosen effort needs", () => {
    expect(completionTokenCeiling(undefined, "none")).toBe(4_000);
    expect(completionTokenCeiling(undefined, "medium")).toBe(12_000);
    expect(completionTokenCeiling(undefined, "max")).toBe(36_000);
  });

  it("goes by the model's own default when none is chosen", () => {
    expect(completionTokenCeiling(offering("low"), undefined)).toBe(8_000);
    expect(completionTokenCeiling(offering("low"), "medium")).toBe(12_000);
  });

  it("leaves plenty of room when the model doesn't say", () => {
    expect(completionTokenCeiling(offering(null), undefined)).toBe(20_000);
    expect(completionTokenCeiling(undefined, undefined)).toBe(20_000);
  });

  it("stays within what the model can write", () => {
    expect(completionTokenCeiling({ maxOutputTokens: 8_192 }, "max")).toBe(
      8_192,
    );
    expect(completionTokenCeiling({ maxOutputTokens: 128_000 }, "max")).toBe(
      36_000,
    );
  });
});

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
