import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import type { Mock } from "vitest";
import { vi } from "vitest";

export type FakeProcessStep = { afterMs?: number } & (
  { line: unknown } | { raw: string }
);

type FakeProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  kill: Mock;
  /** What the app wrote to the process's stdin. */
  input: () => string;
};

/**
 * A `spawn` stand-in for a program that prints each step's line, as JSON (or
 * its raw text), after its delay, then exits with `code` (or, with `end: false`, stalls).
 * Aborting the spawn's signal kills it the way Node does: an AbortError, then
 * close. Like a real process, it closes only once its output has been read.
 */
export function fakeProcess(
  steps: Iterable<FakeProcessStep>,
  { end = true, code = 0, stderr = "" } = {},
) {
  return (
    _command: string,
    _args: string[],
    options: { signal?: AbortSignal } = {},
  ) => {
    let input = "";
    let finished = false;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      kill: vi.fn(() => finish(null)),
      input: () => input,
    }) as FakeProcess;
    child.stdin.setEncoding("utf8").on("data", (chunk) => (input += chunk));

    function finish(exitCode: number | null) {
      if (finished) return;
      finished = true;
      child.exitCode = exitCode;
      void Promise.all([
        once(child.stdout, "end"),
        once(child.stderr, "end"),
      ]).then(() => child.emit("close", exitCode));
      child.stdout.end();
      child.stderr.end(stderr);
    }

    options.signal?.addEventListener(
      "abort",
      () => {
        child.emit(
          "error",
          Object.assign(new Error("aborted"), { name: "AbortError" }),
        );
        finish(null);
      },
      { once: true },
    );

    void (async () => {
      for (const step of steps) {
        if (step.afterMs) {
          await new Promise((resolve) => setTimeout(resolve, step.afterMs));
        }
        if (finished) return;
        child.stdout.write(
          `${"raw" in step ? step.raw : JSON.stringify(step.line)}\n`,
        );
      }
      if (end) finish(code);
    })();

    return child;
  };
}

/** The command, arguments, options and process of the `n`th spawn. */
export function spawned(spawn: Mock, n = 0) {
  const [command, args, options] = spawn.mock.calls[n] as [
    string,
    string[],
    { env?: NodeJS.ProcessEnv; signal?: AbortSignal; cwd?: string },
  ];
  const child = spawn.mock.results[n]?.value as FakeProcess;
  return { command, args, options, child };
}

/** The value given after `flag` on a command line. */
export function valueOf(args: string[], flag: string) {
  return args[args.indexOf(flag) + 1];
}
