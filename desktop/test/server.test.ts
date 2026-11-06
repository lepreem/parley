import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServerStartError, startServer } from "../src/server";

let dir: string;

/** A stand-in for the bundled server, behind the real run.mjs. */
async function serverDirWith(api: string) {
  const serverDir = path.join(dir, "server");
  await mkdir(path.join(serverDir, "dist"), { recursive: true });
  await copyFile("static/run.mjs", path.join(serverDir, "run.mjs"));
  await writeFile(path.join(serverDir, "dist", "api.js"), api);
  await writeFile(
    path.join(serverDir, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  return serverDir;
}

function options(serverDir: string) {
  return {
    serverDir,
    clientDir: "/client",
    dataDir: path.join(dir, "data"),
    claudePath: "/claude",
    ytDlpPath: "/yt-dlp",
    searchPath: process.env.PATH ?? "",
  };
}

const HEALTHY = `
import { createServer } from "node:http";
const server = createServer((_req, res) => res.end(JSON.stringify(process.env.CLIENT_DIR)));
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => { server.close(); process.exit(0); });
`;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "parley-server-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("startServer", () => {
  it("resolves once the server answers, passing it its settings", async () => {
    const server = await startServer(options(await serverDirWith(HEALTHY)));
    const response = await fetch(`${server.url}/health`);
    expect(await response.json()).toBe("/client");
    await server.stop();
  });

  it("stops the server by closing its stdin", async () => {
    const server = await startServer(options(await serverDirWith(HEALTHY)));
    await server.stop();
    await server.exited;
    await expect(fetch(`${server.url}/health`)).rejects.toThrow();
  });

  it("passes phone access on to the running server", async () => {
    const server = await startServer(
      options(
        await serverDirWith(`
import { createServer } from "node:http";
let last = "nothing";
process.on("message", (message) => { last = message; });
const http = createServer((_req, res) => res.end(JSON.stringify(last)));
http.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => { http.close(); process.exit(0); });
`),
      ),
    );
    server.allowPhoneAccess({
      hostname: "mac.ts.net",
      login: "me@example.com",
    });
    await expect
      .poll(async () => (await fetch(`${server.url}/health`)).json())
      .toEqual({ hostname: "mac.ts.net", login: "me@example.com" });

    server.allowPhoneAccess(undefined);
    await expect
      .poll(async () => (await fetch(`${server.url}/health`)).json())
      .toEqual({ hostname: null, login: null });
    await server.stop();
  });

  it("fails with what the server printed when it can't start", async () => {
    const serverDir = await serverDirWith(
      `console.error("Claude Code is unavailable"); process.exit(1);`,
    );
    const failure = await startServer(options(serverDir)).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ServerStartError);
    expect((failure as ServerStartError).output).toContain(
      "Claude Code is unavailable",
    );
  });
});
