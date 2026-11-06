import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  enableHttpsUrl,
  isServing,
  parseStatus,
  readTailscale,
  startServe,
} from "../src/tailscale";

const RUNNING = {
  BackendState: "Running",
  Self: { DNSName: "MacBook.tail1234.ts.net.", UserID: 7 },
  User: { "7": { LoginName: "me@example.com" } },
};

describe("parseStatus", () => {
  it("reads this machine's name, without the final dot, and its account", () => {
    expect(parseStatus(JSON.stringify(RUNNING), "tailscale")).toEqual({
      state: "ready",
      program: "tailscale",
      hostname: "macbook.tail1234.ts.net",
      login: "me@example.com",
    });
  });

  it.each(["NeedsLogin", "Stopped", "Starting"])(
    "counts %s as signed out",
    (BackendState) => {
      expect(
        parseStatus(JSON.stringify({ ...RUNNING, BackendState }), "tailscale"),
      ).toEqual({ state: "signedOut" });
    },
  );

  it("counts no output as signed out, which is a daemon not running", () => {
    expect(parseStatus("", "tailscale")).toEqual({ state: "signedOut" });
  });

  it("won't name an account it can't find", () => {
    expect(
      parseStatus(JSON.stringify({ ...RUNNING, User: {} }), "tailscale"),
    ).toEqual({ state: "signedOut" });
  });

  it("recognises a tagged machine, which belongs to no account", () => {
    const tagged = { ...RUNNING, Self: { ...RUNNING.Self, Tags: ["tag:x"] } };
    expect(parseStatus(JSON.stringify(tagged), "tailscale")).toEqual({
      state: "tagged",
    });
  });
});

describe("what tailscale serve prints", () => {
  it("is recognised once it's serving", () => {
    expect(
      isServing(
        "Available within your tailnet:\n\nhttps://mac.ts.net/\n|-- proxy http://127.0.0.1:47821\n",
      ),
    ).toBe(true);
  });

  it("gives the page that allows HTTPS", () => {
    expect(
      enableHttpsUrl(
        "\nServe is not enabled on your tailnet.\n\n         https://login.tailscale.com/f/serve?node=abc\n\n",
      ),
    ).toBe("https://login.tailscale.com/f/serve?node=abc");
  });

  it("gives no page for an address that isn't Tailscale's", () => {
    expect(enableHttpsUrl("visit https://evil.test/f/serve")).toBeUndefined();
  });
});

describe("the tailscale program", () => {
  let dir: string;

  /** A stand-in `tailscale` on the PATH, run by this same Node. */
  async function fakeTailscale(body: string) {
    const program = path.join(dir, "tailscale");
    await writeFile(program, `#!${process.execPath}\n${body}`);
    await chmod(program, 0o755);
  }

  const searchPath = () => `${dir}${path.delimiter}${process.env.PATH ?? ""}`;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "parley-tailscale-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is missing when it's in none of the places looked", async () => {
    expect(await readTailscale(dir, "linux")).toEqual({ state: "missing" });
  });

  it("answers with this machine's state", async () => {
    await fakeTailscale(
      `console.log(${JSON.stringify(JSON.stringify(RUNNING))});`,
    );
    expect(await readTailscale(searchPath(), "linux")).toMatchObject({
      state: "ready",
      hostname: "macbook.tail1234.ts.net",
    });
  });

  it("reads as signed out when its daemon isn't running", async () => {
    await fakeTailscale(`console.error("failed to connect"); process.exit(1);`);
    expect(await readTailscale(searchPath(), "linux")).toEqual({
      state: "signedOut",
    });
  });

  it("is given the port to serve, and reports what it prints", async () => {
    await fakeTailscale(
      `console.log(process.argv.slice(2).join(" ")); process.exit(3);`,
    );
    const { code, output } = await new Promise<{
      code: number | null;
      output: string;
    }>((resolve) => {
      startServe(
        "tailscale",
        47821,
        searchPath(),
        () => {},
        (exitCode, printed) => resolve({ code: exitCode, output: printed }),
      );
    });
    expect(code).toBe(3);
    expect(output).toContain("serve 47821");
  });

  it("reports a program that won't start", async () => {
    const output = await new Promise<string>((resolve) => {
      startServe(
        path.join(dir, "gone"),
        47821,
        dir,
        () => {},
        (_code, printed) => resolve(printed),
      );
    });
    expect(output).toContain("ENOENT");
  });

  it("ends when stopped, taking the serving with it", async () => {
    await fakeTailscale(
      `console.log("Available within your tailnet"); setInterval(() => {}, 1000);`,
    );
    await new Promise<void>((resolve) => {
      const serve = startServe(
        "tailscale",
        47821,
        searchPath(),
        () => serve.stop(),
        () => resolve(),
      );
    });
  });
});
