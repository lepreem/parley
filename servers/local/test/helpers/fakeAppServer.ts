import { EventEmitter, once } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { vi } from "vitest";

/** A JSON-RPC message, either way. */
export type RpcLine = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/** What the stand-in can do in reply to one of the app's messages. */
export type AppServerControls = {
  /** Writes a line to the app, as the server would. */
  emit: (line: RpcLine) => void;
  /** Ends the run, as the server exiting would. */
  exit: (code?: number) => void;
};

/**
 * A `spawn` stand-in for `codex app-server` that answers each message the app
 * sends with whatever `onMessage` does, and records them all. Aborting the
 * spawn's signal kills it the way Node does: an AbortError, then close.
 */
export function fakeAppServer(
  onMessage: (message: RpcLine, controls: AppServerControls) => void,
) {
  const runs: {
    args: string[];
    options: Record<string, unknown>;
    received: RpcLine[];
  }[] = [];

  const spawn = (
    _command: string,
    args: string[],
    options: { signal?: AbortSignal } & Record<string, unknown> = {},
  ) => {
    const received: RpcLine[] = [];
    runs.push({ args, options, received });
    let finished = false;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      kill: vi.fn(() => finish(null)),
    });

    function finish(exitCode: number | null) {
      if (finished) return;
      finished = true;
      child.exitCode = exitCode;
      void Promise.all([
        once(child.stdout, "end"),
        once(child.stderr, "end"),
      ]).then(() => child.emit("close", exitCode));
      child.stdout.end();
      child.stderr.end();
    }

    const controls: AppServerControls = {
      emit: (line) => {
        if (!finished) child.stdout.write(`${JSON.stringify(line)}\n`);
      },
      exit: (code = 0) => finish(code),
    };

    createInterface({ input: child.stdin }).on("line", (line) => {
      const message = JSON.parse(line) as RpcLine;
      received.push(message);
      onMessage(message, controls);
    });

    options.signal?.addEventListener(
      "abort",
      () => {
        const error = Object.assign(new Error("The operation was aborted"), {
          name: "AbortError",
        });
        child.emit("error", error);
        finish(null);
      },
      { once: true },
    );

    // Like a real process, nothing it writes arrives before the caller listens.
    child.stdout.pause();
    queueMicrotask(() => child.stdout.resume());
    return child;
  };

  return { spawn, runs };
}
