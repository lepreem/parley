import { describe, expect, it } from "vitest";
import { withoutLink } from "./youtube";

const url = "https://youtu.be/uMGR09IUpms?is=F1U1_jxIvCbdl4OE";

describe("withoutLink", () => {
  it("drops a link that opens the message", () => {
    expect(withoutLink(`${url} what's the point then?`, url)).toBe(
      "what's the point then?",
    );
  });

  it("drops a link that ends the message", () => {
    expect(withoutLink(`summarise this ${url}`, url)).toBe("summarise this");
  });

  it("keeps one space between the words either side", () => {
    expect(withoutLink(`look at  ${url}  and tell me`, url)).toBe(
      "look at and tell me",
    );
  });

  it("keeps the user's line breaks", () => {
    expect(withoutLink(`first line\n${url}\nsecond line`, url)).toBe(
      "first line\n\nsecond line",
    );
  });

  it("drops every copy of the link", () => {
    expect(withoutLink(`${url} vs ${url}`, url)).toBe("vs");
  });

  it("reads the link's ? and . as plain text", () => {
    // Read as a pattern, "." would match the X and "s?" would match no s.
    const lookalike = "https://youtuXbe/uMGR09IUpmis=F1U1_jxIvCbdl4OE";
    expect(withoutLink(`${lookalike} hi`, url)).toBe(`${lookalike} hi`);
  });

  it("leaves nothing when the link was the whole message", () => {
    expect(withoutLink(`  ${url}  `, url)).toBe("");
  });
});
