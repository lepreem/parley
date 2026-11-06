import { describe, expect, it } from "vitest";
import { qrFor } from "../src/qr";

describe("qrFor", () => {
  it("draws a QR code big enough for the address, as dark squares", () => {
    const { size, path } = qrFor("https://macbook.tail1234.ts.net/");
    // Sizes go up in fours from 21.
    expect((size - 21) % 4).toBe(0);
    expect(path).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);
    // The top left corner of a finder pattern is always dark.
    expect(path.startsWith("M0 0h1v1h-1z")).toBe(true);
  });
});
