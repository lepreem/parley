import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../core/db", async () =>
  (await import("../helpers/inMemoryDb")).inMemoryDbModule(),
);

import { createApp } from "../../api/app";

/** A built client of two files, for this file's app to serve. */
beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "client-"));
  await writeFile(
    path.join(dir, "index.html"),
    "<!doctype html><html><head><title>app</title></head></html>",
  );
  await mkdir(path.join(dir, "assets"));
  await writeFile(path.join(dir, "assets", "app.js"), "console.log(1)");
  // Read when the app is first built, which is after this.
  process.env.CLIENT_DIR = dir;
});

async function get(urlPath: string) {
  return (await createApp()).request(`http://localhost${urlPath}`);
}

describe("the built client", () => {
  it("is served from the API's own origin", async () => {
    const res = await get("/assets/app.js");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("javascript");
    expect(await res.text()).toBe("console.log(1)");
  });

  it("answers the client's own routes with its page", async () => {
    const res = await get("/chat/550e8400-e29b-41d4-a716-446655440000");

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>app</title>");
  });

  it("leaves any other path to the API, which 404s one it doesn't have", async () => {
    const res = await get(
      "/jobs/summarize/550e8400-e29b-41d4-a716-446655440000",
    );

    expect(res.status).toBe(404);
  });

  it("answers this computer's section with its page", async () => {
    const res = await get("/local/550e8400-e29b-41d4-a716-446655440000");

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>app</title>");
  });

  it("serves the page at the root, where the client starts", async () => {
    const res = await get("/");

    expect(await res.text()).toContain("<title>app</title>");
  });

  it.each([
    "/",
    "/index.html",
    "/chat",
    "/local/550e8400-e29b-41d4-a716-446655440000",
  ])(
    "marks the page at %s as this server's, so it calls this origin",
    async (urlPath) => {
      const res = await get(urlPath);

      expect(await res.text()).toContain(
        '<head><meta name="parley-server" content="local" /><title>app</title>',
      );
    },
  );

  it("leaves the API's routes to the API", async () => {
    const res = await get("/conversations");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversations: [] });
  });
});
