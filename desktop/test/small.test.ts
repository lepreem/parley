import { createServer } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freePort } from "../src/ports";
import { joinPath, pathFromShellOutput } from "../src/shellPath";
import { isNewer, newerRelease } from "../src/updates";
import { bundledYtDlp, ytDlpName } from "../src/ytDlp";

describe("freePort", () => {
  it("takes the preferred port when it's free", async () => {
    const probe = await freePort(0);
    expect(await freePort(probe)).toBe(probe);
  });

  it("takes another when the preferred one is in use", async () => {
    const holder = createServer();
    const port = await new Promise<number>((resolve) => {
      holder.listen(0, "127.0.0.1", () => {
        const address = holder.address();
        resolve(typeof address === "object" ? (address?.port ?? 0) : 0);
      });
    });
    const got = await freePort(port);
    expect(got).not.toBe(port);
    await new Promise((resolve) => holder.close(resolve));
  });
});

describe("the shell's PATH", () => {
  it("is what's between the markers, whatever a profile prints around it", () => {
    expect(
      pathFromShellOutput("Welcome!\n__PARLEY_PATH__/a:/b__PARLEY_PATH__\nBye"),
    ).toBe("/a:/b");
    expect(pathFromShellOutput("no markers")).toBeUndefined();
  });

  it("is joined without repeats or blanks", () => {
    expect(joinPath(["/a", "", "/b", "/a"], ":")).toBe("/a:/b");
  });
});

describe("isNewer", () => {
  it("compares versions as numbers", () => {
    expect(isNewer("v0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.9.0", "0.10.0")).toBe(false);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("1.0.1", "1.0")).toBe(true);
  });
});

describe("newerRelease", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers a newer release", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ tag_name: "v0.2.0", html_url: "https://example/r" }),
      ),
    );
    expect(await newerRelease("0.1.0")).toEqual({
      version: "v0.2.0",
      url: "https://example/r",
    });
    expect(await newerRelease("0.2.0")).toBeUndefined();
  });

  it("stays quiet offline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await newerRelease("0.1.0")).toBeUndefined();
  });
});

describe("bundledYtDlp", () => {
  it("runs the one inside the app, never a copy that could update", () => {
    expect(bundledYtDlp("/app/bin")).toBe(path.join("/app/bin", ytDlpName()));
  });
});
