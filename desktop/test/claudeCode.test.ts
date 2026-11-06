import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeStatus,
  findClaude,
  installerCommand,
  isSignedIn,
} from "../src/claudeCode";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "parley-claude-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function program(name: string, body = "#!/bin/sh\nexit 0\n") {
  const file = path.join(dir, name);
  await writeFile(file, body);
  await chmod(file, 0o755);
  return file;
}

describe.skipIf(process.platform === "win32")("findClaude on Unix", () => {
  it("finds it on the path", async () => {
    const file = await program("claude");
    expect(findClaude(`/nowhere:${dir}`, "linux")).toBe(file);
  });

  it("skips a file that can't run", async () => {
    await writeFile(path.join(dir, "claude"), "");
    expect(findClaude(dir, "linux")).toBeUndefined();
  });
});

describe("findClaude on Windows", () => {
  it("takes only a real program on Windows, not npm's script", async () => {
    await writeFile(path.join(dir, "claude.cmd"), "");
    expect(findClaude(dir, "win32")).toBeUndefined();
    await writeFile(path.join(dir, "claude.exe"), "");
    expect(findClaude(dir, "win32")).toBe(path.join(dir, "claude.exe"));
  });
});

describe("isSignedIn", () => {
  it("reads the output", () => {
    expect(isSignedIn('{"loggedIn":true}')).toBe(true);
    expect(isSignedIn('{"loggedIn":false}')).toBe(false);
  });

  it("isn't signed in if it can't tell", () => {
    expect(isSignedIn("")).toBe(false);
    expect(isSignedIn("Error: boom")).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("claudeStatus", () => {
  it("is missing when there's no Claude Code", async () => {
    expect(await claudeStatus(dir)).toEqual({ state: "missing" });
  });

  it("is ready when it says it's signed in", async () => {
    const claudePath = await program(
      "claude",
      `#!/bin/sh\necho '{"loggedIn":true}'\n`,
    );
    expect(await claudeStatus(dir)).toEqual({ state: "ready", claudePath });
  });

  it("reads a signed-out answer despite its failing exit code", async () => {
    const claudePath = await program(
      "claude",
      `#!/bin/sh\necho '{"loggedIn":false}'\nexit 1\n`,
    );
    expect(await claudeStatus(dir)).toEqual({ state: "signedOut", claudePath });
  });
});

describe("installerCommand", () => {
  it("runs Anthropic's installer for the platform", () => {
    expect(installerCommand("darwin").args.join(" ")).toContain(
      "https://claude.ai/install.sh",
    );
    expect(installerCommand("linux").program).toBe("/bin/bash");
    expect(installerCommand("win32").args.join(" ")).toContain(
      "https://claude.ai/install.ps1",
    );
  });
});
