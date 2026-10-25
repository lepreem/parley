import { describe, expect, it, vi } from "vitest";

vi.mock("@parley/server-kit/runtime/logger", async (importActual) => ({
  ...(await importActual<typeof import("@parley/server-kit/runtime/logger")>()),
  logger: { error: vi.fn() },
}));

import { verifyServices } from "@parley/server-kit/runtime/preflight";

const missing = () =>
  Promise.reject(
    Object.assign(new Error("spawn yt-dlp ENOENT"), { code: "ENOENT" }),
  );

describe("verifyServices", () => {
  it("starts when every check passes", async () => {
    await expect(
      verifyServices([{ name: "yt-dlp", check: async () => {} }]),
    ).resolves.toBeUndefined();
  });

  it("names every failing service, and says a missing program is missing", async () => {
    await expect(
      verifyServices([
        { name: "yt-dlp", check: missing },
        {
          name: "Claude Code",
          check: () => Promise.reject(new Error("Not logged in")),
        },
        { name: "Whisper", check: async () => {} },
      ]),
    ).rejects.toThrow(
      "Startup aborted — the following services are unavailable:\n" +
        "  - yt-dlp: not installed, or not on PATH. The repo root's npm scripts provide it through mise\n" +
        "  - Claude Code: Not logged in",
    );
  });
});
