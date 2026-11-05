import { describe, expect, it } from "vitest";
import { insertSpoken } from "./insertSpoken";

describe("insertSpoken", () => {
  it("fills an empty box", () => {
    expect(insertSpoken("", 0, 0, "Hello.")).toEqual({
      text: "Hello.",
      caret: 6,
    });
  });

  it("adds a space after what's already typed", () => {
    expect(insertSpoken("Hi", 2, 2, "there").text).toBe("Hi there");
  });

  it("doesn't double a space that's already there", () => {
    expect(insertSpoken("Hi ", 3, 3, "there").text).toBe("Hi there");
  });

  it("sets words off on both sides in the middle of the text", () => {
    const result = insertSpoken("onetwo", 3, 3, "and");
    expect(result.text).toBe("one and two");
    expect(result.caret).toBe(8);
  });

  it("replaces the selection", () => {
    expect(insertSpoken("say old here", 4, 7, "new").text).toBe("say new here");
  });
});
