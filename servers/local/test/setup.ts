import { vi } from "vitest";

process.env.NODE_ENV = "test";
// DATA_DIR comes from globalSetup.ts.
process.env.PORT = "3002";
// No built client, whether or not one has been built: the suites that want
// one make their own.
process.env.CLIENT_DIR = "/nonexistent/client";

// createApp() runs a fail-fast preflight that runs Claude Code, Whisper,
// ffmpeg and yt-dlp. Tests don't need them, so stub the preflight to a no-op.
vi.mock("../api/startup", () => ({
  verifyApiServices: vi.fn(async () => {}),
}));
