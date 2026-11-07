import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

import { YtDlpError, refusedFlag, ytDlp } from "../../api/src/ytDlp";

/** A yt-dlp run that prints `stdout` and `stderr`, then exits with `code`. */
function exitsWith(code: number, { stdout = "", stderr = "" } = {}) {
  return () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    setImmediate(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit("close", code);
    });
    return child;
  };
}

function argsOfRun(n = 0): string[] {
  return mockSpawn.mock.calls[n][1];
}

/** The value given after `flag` on the command line. */
function valueOf(args: string[], flag: string) {
  return args[args.indexOf(flag) + 1];
}

beforeEach(() => {
  mockSpawn.mockReset().mockImplementation(exitsWith(0, { stdout: "{}" }));
});

describe("ytDlp", () => {
  it("runs signed out and never updating, ahead of anything else it's told", async () => {
    await ytDlp.probe("https://youtu.be/abc");
    await ytDlp.downloadAudio("https://youtu.be/abc", "/tmp/f", 1_000);
    await ytDlp.ping();

    for (const call of mockSpawn.mock.calls) {
      expect(call[1].slice(0, 5)).toEqual([
        "--ignore-config",
        "--no-plugin-dirs",
        "--no-cookies",
        "--no-cookies-from-browser",
        "--no-update",
      ]);
      expect(refusedFlag(call[1])).toBeUndefined();
    }
  });

  it.each([
    ["--cookies", "cookies.txt"],
    ["--cookies-from-browser", "chrome"],
    ["--cookies=cookies.txt"],
    ["-u", "me"],
    ["--password", "secret"],
    ["--netrc"],
    ["--add-headers", "Cookie:SID=1"],
    ["--config-locations", "mine.conf"],
    ["--plugin-dirs", "plugins"],
    ["-U"],
    ["--update"],
    ["--update-to", "nightly"],
  ])("refuses options that would sign in or update yt-dlp: %s", (...flag) => {
    expect(
      refusedFlag(["--no-playlist", ...flag, "https://youtu.be/abc"]),
    ).toBe(flag[0]);
  });

  it("hands the abort signal to the process it runs", async () => {
    const { signal } = new AbortController();

    await ytDlp.probe("https://youtu.be/abc", signal);
    await ytDlp.downloadAudio("https://youtu.be/abc", "/tmp/f", 1_000, signal);

    expect(mockSpawn.mock.calls[0][2]).toMatchObject({ signal });
    expect(mockSpawn.mock.calls[1][2]).toMatchObject({ signal });
  });

  it("solves YouTube's JavaScript challenge with this process's node", async () => {
    await ytDlp.probe("https://youtu.be/abc");

    expect(valueOf(argsOfRun(), "--js-runtimes")).toBe(
      `node:${process.execPath}`,
    );
  });

  it("probes with the audio format a download would pick", async () => {
    mockSpawn.mockImplementation(
      exitsWith(0, { stdout: JSON.stringify({ filesize: 5 }) }),
    );

    expect(await ytDlp.probe("https://youtu.be/abc")).toEqual({ filesize: 5 });
    expect(valueOf(argsOfRun(), "--format")).toBe("worstaudio/bestaudio/best");
    expect(argsOfRun()).toContain("--dump-single-json");
  });

  it("downloads under the size cap, in ranged chunks, to the directory given", async () => {
    await ytDlp.downloadAudio("https://youtu.be/abc", "/tmp/fetch", 1_000);

    const args = argsOfRun();
    expect(valueOf(args, "--max-filesize")).toBe("1000");
    expect(valueOf(args, "--http-chunk-size")).toBe("1M");
    expect(valueOf(args, "--output")).toBe("/tmp/fetch/audio.%(ext)s");
    expect(args.at(-1)).toBe("https://youtu.be/abc");
  });

  it("fails with the last error yt-dlp printed", async () => {
    mockSpawn.mockImplementation(
      exitsWith(1, {
        stderr:
          "WARNING: something minor\nERROR: [youtube] abc: Video unavailable\n",
      }),
    );

    const failure = ytDlp.probe("https://youtu.be/abc");
    await expect(failure).rejects.toBeInstanceOf(YtDlpError);
    await expect(failure).rejects.toThrow(
      "ERROR: [youtube] abc: Video unavailable",
    );
  });

  it("fails with the exit code when yt-dlp printed no error", async () => {
    mockSpawn.mockImplementation(exitsWith(2));

    await expect(ytDlp.ping()).rejects.toThrow("yt-dlp exited with code 2");
  });
});
