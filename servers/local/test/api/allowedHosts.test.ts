import { describe, expect, it, vi } from "vitest";

vi.mock("../../core/db", async () =>
  (await import("../helpers/inMemoryDb")).inMemoryDbModule(),
);

// The Tailscale name a phone would reach the app by. Read when the app is
// first built, which is after this.
process.env.ALLOWED_HOSTS = "macbook.tail1234.ts.net";
// The hosted client, which calls this machine from the browser.
process.env.ALLOWED_ORIGINS = "https://parley.example.app/";

import { createApp } from "../../api/app";

async function request(url: string, init: RequestInit = {}) {
  return (await createApp()).request(url, init);
}

/** A multipart upload, the kind of request a browser sends unasked. */
function formPost(origin: string) {
  return request("http://localhost/upload/image", {
    method: "POST",
    headers: { Origin: origin },
    body: new FormData(),
  });
}

describe("requests from off this machine", () => {
  it("are refused when addressed to another name, as DNS rebinding does", async () => {
    expect((await request("http://evil.test/conversations")).status).toBe(403);
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "are answered when addressed to %s",
    async (hostname) => {
      expect((await request(`http://${hostname}/conversations`)).status).toBe(
        200,
      );
    },
  );

  it("are answered when addressed to a name in ALLOWED_HOSTS", async () => {
    expect(
      (await request("https://macbook.tail1234.ts.net/conversations")).status,
    ).toBe(200);
  });

  it("go through when a form post comes from a page under a name in ALLOWED_HOSTS", async () => {
    expect((await formPost("https://macbook.tail1234.ts.net")).status).toBe(
      400,
    );
  });

  it("are refused when a form post comes from another site", async () => {
    expect((await formPost("https://evil.test")).status).toBe(403);
  });

  it.each(["http://localhost:3002", "http://127.0.0.1:5173"])(
    "go through when a form post comes from a page at %s",
    async (origin) => {
      // Past the origin check, the empty form fails validation instead.
      expect((await formPost(origin)).status).toBe(400);
    },
  );

  it("get no CORS headers to read a response with", async () => {
    const res = await request("http://localhost/conversations", {
      headers: { Origin: "https://evil.test" },
    });

    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

/** The preflight a browser sends before another origin's JSON request. */
function preflight(origin: string, headers: Record<string, string> = {}) {
  return request("http://localhost/conversations", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
      ...headers,
    },
  });
}

describe("pages from another origin", () => {
  it("may call the API when the origin is in ALLOWED_ORIGINS", async () => {
    const res = await preflight("https://parley.example.app");

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://parley.example.app",
    );
  });

  it("may call the API from this machine, as the Vite dev server does", async () => {
    const res = await preflight("http://localhost:5173");

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:5173",
    );
  });

  it("are refused at the preflight when the origin isn't trusted", async () => {
    const res = await preflight("https://evil.test");

    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("are told this machine may be reached, when Chrome asks", async () => {
    const res = await preflight("https://parley.example.app", {
      "Access-Control-Request-Private-Network": "true",
    });

    expect(res.headers.get("Access-Control-Allow-Private-Network")).toBe(
      "true",
    );
  });

  it("aren't told so when the origin isn't trusted", async () => {
    const res = await preflight("https://evil.test", {
      "Access-Control-Request-Private-Network": "true",
    });

    expect(res.headers.get("Access-Control-Allow-Private-Network")).toBeNull();
  });

  it("may post a form from an origin in ALLOWED_ORIGINS", async () => {
    expect((await formPost("https://parley.example.app")).status).toBe(400);
  });
});
