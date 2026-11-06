import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhoneAccess } from "../src/phoneAccess";
import type { TailscaleStatus } from "../src/tailscale";

const READY: TailscaleStatus = {
  state: "ready",
  program: "tailscale",
  hostname: "mac.tail.ts.net",
  login: "me@example.com",
};

type StartedServe = {
  port: number;
  print(output: string): void;
  exit(code: number | null, output: string): void;
  stop: ReturnType<typeof vi.fn>;
};

function setUp({ enabled = false } = {}) {
  let tailscale: TailscaleStatus = READY;
  const serves: StartedServe[] = [];
  const allow = vi.fn();
  const started = vi.fn();
  const saveEnabled = vi.fn();
  const access = new PhoneAccess({
    loadEnabled: () => enabled,
    saveEnabled,
    readTailscale: () => Promise.resolve(tailscale),
    startServe: (_program, port, onOutput, onExit) => {
      const stop = vi.fn();
      started();
      serves.push({ port, print: onOutput, exit: onExit, stop });
      return { stop };
    },
    allow,
    qrFor: () => ({ size: 1, path: "M0 0" }),
    onChange: () => {},
  });
  return {
    access,
    serves,
    allow,
    started,
    saveEnabled,
    setTailscale: (next: TailscaleStatus) => {
      tailscale = next;
    },
  };
}

const SERVING = "Available within your tailnet:\n";

describe("PhoneAccess", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts off, and does nothing until asked", async () => {
    const { access, serves } = setUp();
    access.serverChanged(1000);
    await access.check();
    expect(access.getState()).toEqual({ status: "off" });
    expect(serves).toEqual([]);
  });

  it("tells the server the name and account before it serves them", async () => {
    const { access, serves, allow, started, saveEnabled } = setUp();
    access.serverChanged(1000);
    await access.enable();
    expect(saveEnabled).toHaveBeenCalledWith(true);
    expect(allow).toHaveBeenCalledWith({
      hostname: "mac.tail.ts.net",
      login: "me@example.com",
    });
    expect(allow.mock.invocationCallOrder[0]).toBeLessThan(
      started.mock.invocationCallOrder[0] ?? 0,
    );
    expect(serves).toHaveLength(1);
    expect(serves[0]?.port).toBe(1000);
    expect(access.getState().status).toBe("starting");

    serves[0]?.print(SERVING);
    expect(access.getState()).toMatchObject({
      status: "on",
      url: "https://mac.tail.ts.net/",
      login: "me@example.com",
    });
  });

  it("comes back on by itself on the next launch", async () => {
    const { access, serves } = setUp({ enabled: true });
    expect(access.getState().status).toBe("starting");
    access.serverChanged(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(serves).toHaveLength(1);
    access.shutdown();
  });

  it("stops serving and forgets the name when turned off", async () => {
    const { access, serves, allow, saveEnabled } = setUp();
    access.serverChanged(1000);
    await access.enable();
    access.disable();
    expect(serves[0]?.stop).toHaveBeenCalled();
    expect(allow).toHaveBeenLastCalledWith(undefined);
    expect(saveEnabled).toHaveBeenLastCalledWith(false);
    expect(access.getState()).toEqual({ status: "off" });
  });

  it("serves nothing if turned off while Tailscale answers", async () => {
    const { access, serves } = setUp();
    access.serverChanged(1000);
    const enabling = access.enable();
    access.disable();
    await enabling;
    expect(serves).toEqual([]);
    expect(access.getState()).toEqual({ status: "off" });
  });

  it.each(["missing", "signedOut"] as const)(
    "waits while Tailscale is %s, then carries on by itself",
    async (state) => {
      const { access, serves, allow, setTailscale } = setUp();
      setTailscale({ state });
      access.serverChanged(1000);
      await access.enable();
      expect(access.getState()).toEqual({ status: state });
      expect(serves).toEqual([]);
      expect(allow).toHaveBeenLastCalledWith(undefined);

      setTailscale(READY);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(serves).toHaveLength(1);
      access.shutdown();
    },
  );

  it("refuses a tagged machine, which can't say whose phone is asking", async () => {
    const { access, serves, setTailscale } = setUp();
    setTailscale({ state: "tagged" });
    access.serverChanged(1000);
    await access.enable();
    expect(access.getState().status).toBe("failed");
    expect(serves).toEqual([]);
    access.shutdown();
  });

  it("stops serving when the person signs out of Tailscale", async () => {
    const { access, serves, allow, setTailscale } = setUp();
    access.serverChanged(1000);
    await access.enable();
    serves[0]?.print(SERVING);

    setTailscale({ state: "signedOut" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(serves[0]?.stop).toHaveBeenCalled();
    expect(allow).toHaveBeenLastCalledWith(undefined);
    expect(access.getState()).toEqual({ status: "signedOut" });
    access.shutdown();
  });

  it("serves again for a new account, telling the server first", async () => {
    const { access, serves, allow, setTailscale } = setUp();
    access.serverChanged(1000);
    await access.enable();

    setTailscale({ ...READY, login: "other@example.com" } as TailscaleStatus);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(serves[0]?.stop).toHaveBeenCalled();
    expect(serves).toHaveLength(2);
    expect(allow).toHaveBeenLastCalledWith({
      hostname: "mac.tail.ts.net",
      login: "other@example.com",
    });
    access.shutdown();
  });

  it("leaves a healthy serve alone between checks", async () => {
    const { access, serves } = setUp();
    access.serverChanged(1000);
    await access.enable();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(serves).toHaveLength(1);
    access.shutdown();
  });

  it("shows what failed, then tries again", async () => {
    const { access, serves, allow } = setUp();
    access.serverChanged(1000);
    await access.enable();
    serves[0]?.exit(1, "Access denied");
    expect(access.getState()).toEqual({
      status: "failed",
      output: "Access denied",
    });
    expect(allow).toHaveBeenLastCalledWith(undefined);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(serves).toHaveLength(2);
    serves[1]?.print(SERVING);
    expect(access.getState().status).toBe("on");
    access.shutdown();
  });

  it("sends the person to allow HTTPS, and picks up once they have", async () => {
    const { access, serves } = setUp();
    access.serverChanged(1000);
    await access.enable();
    const prompt = "visit https://login.tailscale.com/f/serve?node=a\n";
    serves[0]?.print(prompt);
    expect(access.getState()).toEqual({
      status: "needsHttps",
      url: "https://login.tailscale.com/f/serve?node=a",
    });

    // Tailscale's waiting version carries straight on to serving.
    serves[0]?.print(`${prompt}Success.\n${SERVING}`);
    expect(access.getState().status).toBe("on");
    access.shutdown();
  });

  it("keeps asking for HTTPS when Tailscale printed the page and left", async () => {
    const { access, serves } = setUp();
    access.serverChanged(1000);
    await access.enable();
    const prompt = "visit https://login.tailscale.com/f/serve?node=a\n";
    serves[0]?.print(prompt);
    serves[0]?.exit(0, prompt);
    expect(access.getState().status).toBe("needsHttps");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(serves).toHaveLength(2);
    access.shutdown();
  });

  it("follows the server to a new port", async () => {
    const { access, serves, allow } = setUp();
    access.serverChanged(1000);
    await access.enable();
    serves[0]?.print(SERVING);

    access.serverChanged(undefined);
    expect(serves[0]?.stop).toHaveBeenCalled();
    expect(access.getState().status).toBe("starting");

    allow.mockClear();
    access.serverChanged(2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(serves[1]?.port).toBe(2000);
    // The new server has to be told again.
    expect(allow).toHaveBeenCalledTimes(1);
    access.shutdown();
  });

  it("ignores what an old serve says after it's been replaced", async () => {
    const { access, serves } = setUp();
    access.serverChanged(1000);
    await access.enable();
    access.serverChanged(2000);
    await vi.advanceTimersByTimeAsync(0);
    serves[0]?.exit(1, "killed");
    expect(access.getState().status).toBe("starting");
    access.shutdown();
  });

  it("stops serving on quit but keeps the setting", async () => {
    const { access, serves, saveEnabled } = setUp();
    access.serverChanged(1000);
    await access.enable();
    saveEnabled.mockClear();
    access.shutdown();
    expect(serves[0]?.stop).toHaveBeenCalled();
    expect(saveEnabled).not.toHaveBeenCalled();
  });
});
