import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onShutdown } from "@parley/server-kit/runtime/shutdown";

/**
 * The drain itself is process-specific; what is shared — and what decides
 * whether a deploy hangs — is this: exit 0 only on a clean drain, never wait
 * longer than the grace period, and never start a second drain.
 */
describe("onShutdown", () => {
  let exit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });

  it("exits 0 once the drain resolves", async () => {
    const drain = vi.fn().mockResolvedValue(undefined);
    onShutdown(drain);

    process.emit("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(drain).toHaveBeenCalledOnce();
  });

  it("exits 1 when the drain fails", async () => {
    onShutdown(vi.fn().mockRejectedValue(new Error("mq closed badly")));

    process.emit("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it("exits anyway when the drain outlasts its grace period", async () => {
    // A drain that never settles must not be what decides how long a deploy
    // takes — the orchestrator's SIGKILL should never be the thing that lands.
    onShutdown(() => new Promise<void>(() => {}), { graceMs: 5_000 });

    process.emit("SIGTERM");
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does not start a second drain when signalled again", async () => {
    const drain = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    onShutdown(drain);

    process.emit("SIGTERM");
    process.emit("SIGINT");

    expect(drain).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
