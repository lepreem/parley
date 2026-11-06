import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexStatus } from "../src/codex";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "parley-codex-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function codexThat(body: string) {
  const file = path.join(dir, "codex");
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

describe.skipIf(process.platform === "win32")("codexStatus", () => {
  it("is missing when there's no Codex", async () => {
    expect(await codexStatus(dir)).toEqual({ state: "missing" });
  });

  it("is ready when `codex login status` passes", async () => {
    const codexPath = await codexThat('echo "Logged in using ChatGPT"');
    expect(await codexStatus(dir)).toEqual({ state: "ready", codexPath });
  });

  it("is signed out when it fails", async () => {
    const codexPath = await codexThat('echo "Not logged in"\nexit 1');
    expect(await codexStatus(dir)).toEqual({ state: "signedOut", codexPath });
  });
});
