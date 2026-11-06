import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/db", async () =>
  (await import("../helpers/inMemoryDb")).inMemoryDbModule(),
);

// The Tailscale name a phone would reach the app by. Read when the app is
// first built, which is after this.
process.env.ALLOWED_HOSTS = "macbook.tail1234.ts.net";

import { createApp } from "../../api/app";
import { receivePhoneAccess } from "../../api/src/allowedHosts";

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

describe("the desktop app's phone access", () => {
  const PHONE_NAME = "laptop.tail1234.ts.net";
  const PHONE_URL = `https://${PHONE_NAME}/conversations`;
  const fromAccount = (login: string) => ({
    headers: { "Tailscale-User-Login": login },
  });

  afterEach(() => {
    receivePhoneAccess({ hostname: null, login: null });
  });

  it("answers no one under its name until the app turns it on", async () => {
    const res = await request(PHONE_URL, fromAccount("me@example.com"));
    expect(res.status).toBe(403);
  });

  describe("once on", () => {
    beforeEach(() => {
      receivePhoneAccess({ hostname: PHONE_NAME, login: "me@example.com" });
    });

    it("answers the account that turned it on", async () => {
      const res = await request(PHONE_URL, fromAccount("me@example.com"));
      expect(res.status).toBe(200);
    });

    it("refuses another account on the same tailnet", async () => {
      const res = await request(PHONE_URL, fromAccount("them@example.com"));
      expect(res.status).toBe(403);
    });

    it("refuses a request that names no account, as from outside the tailnet", async () => {
      expect((await request(PHONE_URL)).status).toBe(403);
    });

    it("lets its own page post a form", async () => {
      const res = await request(`https://${PHONE_NAME}/upload/image`, {
        method: "POST",
        headers: {
          Origin: `https://${PHONE_NAME}`,
          "Tailscale-User-Login": "me@example.com",
        },
        body: new FormData(),
      });
      // Past the origin check, the empty form fails validation instead.
      expect(res.status).toBe(400);
    });

    it("leaves this machine's own requests alone", async () => {
      const res = await request("http://127.0.0.1/conversations");
      expect(res.status).toBe(200);
    });

    it("still refuses other names", async () => {
      const res = await request(
        "https://evil.test/conversations",
        fromAccount("me@example.com"),
      );
      expect(res.status).toBe(403);
    });
  });

  it("stops answering once the app turns it off", async () => {
    receivePhoneAccess({ hostname: PHONE_NAME, login: "me@example.com" });
    receivePhoneAccess({ hostname: null, login: null });
    const res = await request(PHONE_URL, fromAccount("me@example.com"));
    expect(res.status).toBe(403);
  });

  it("ignores a message that isn't one of its own", async () => {
    receivePhoneAccess({ hostname: PHONE_NAME, login: "me@example.com" });
    receivePhoneAccess("anything");
    receivePhoneAccess({ hostname: 7 });
    const res = await request(PHONE_URL, fromAccount("me@example.com"));
    expect(res.status).toBe(200);
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
});
