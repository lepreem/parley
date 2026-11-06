import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ytDlp } from "../../api/src/ytDlp";

/**
 * The real yt-dlp, run the way Parley runs it, on a computer set up to sign
 * it in: a yt-dlp config file that hands it a cookie and an Authorization
 * header. Parley's runs must send neither. The first test shows the setup
 * really does sign a plain run in, so the others can't pass by accident.
 *
 * Uses YT_DLP_PATH, or yt-dlp on PATH, as the local server does.
 */
const ytDlpPath = process.env.YT_DLP_PATH ?? "yt-dlp";

/** yt-dlp can take a while to start, more so the pip-installed one. */
const RUN_TIMEOUT_MS = 60_000;

let server: Server;
let audioUrl: string;
let home: string;
let savedEnv: NodeJS.ProcessEnv;
const seen: IncomingHttpHeaders[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push(request.headers);
    response.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Content-Length": "1000",
    });
    response.end(Buffer.alloc(1000));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  audioUrl = `http://127.0.0.1:${port}/audio.mp3`;

  home = mkdtempSync(path.join(tmpdir(), "parley-ytdlp-home-"));
  const cookies = path.join(home, "cookies.txt");
  writeFileSync(
    cookies,
    "# Netscape HTTP Cookie File\n" +
      "127.0.0.1\tFALSE\t/\tFALSE\t0\tSID\tplanted-cookie\n",
  );
  const config = [
    // Forward slashes: the config's parser reads a backslash as an escape.
    `--cookies "${cookies.replaceAll("\\", "/")}"`,
    '--add-headers "Authorization:Bearer planted-token"',
  ].join("\n");
  // Where yt-dlp looks for a person's config on each system.
  for (const dir of [
    path.join(home, ".config", "yt-dlp"),
    path.join(home, "AppData", "Roaming", "yt-dlp"),
  ]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config"), config);
  }
  writeFileSync(path.join(home, "yt-dlp.conf"), config);

  savedEnv = { ...process.env };
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
  });
});

afterAll(() => {
  process.env = savedEnv;
  server.close();
  rmSync(home, { recursive: true, force: true });
});

function signedIn(headers: IncomingHttpHeaders) {
  return Boolean(headers.cookie || headers.authorization);
}

describe("yt-dlp as Parley runs it", { timeout: RUN_TIMEOUT_MS }, () => {
  it("is set up so a plain run would sign in", async () => {
    seen.length = 0;
    // Not execFileSync: it would hold up this process, server and all.
    await promisify(execFile)(
      ytDlpPath,
      ["--quiet", "-o", path.join(home, "plain.%(ext)s"), audioUrl],
      {
        env: process.env,
        cwd: home,
      },
    );

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(signedIn)).toBe(true);
  });

  it("sends no cookie or Authorization header when probing", async () => {
    seen.length = 0;
    await ytDlp.probe(audioUrl);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some(signedIn)).toBe(false);
  });

  it("sends no cookie or Authorization header when downloading", async () => {
    seen.length = 0;
    const directory = mkdtempSync(path.join(home, "download-"));
    await ytDlp.downloadAudio(audioUrl, directory, 10_000);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some(signedIn)).toBe(false);
  });
});
