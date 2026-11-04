import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

/** Where Claude Code stands on this computer. */
export type ClaudeStatus =
  | { state: "missing" }
  | { state: "signedOut"; claudePath: string }
  | { state: "ready"; claudePath: string };

function isExecutable(file: string, platform: NodeJS.Platform): boolean {
  try {
    accessSync(file, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first Claude Code on `searchPath`. On Windows only a real program counts:
 * npm's `claude.cmd` can't be started without a shell, and the server starts
 * Claude Code directly, so a computer with only that is offered the official
 * install, which is what the app can run.
 */
export function findClaude(
  searchPath: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const name = platform === "win32" ? "claude.exe" : "claude";
  const delimiter = platform === "win32" ? ";" : ":";
  for (const dir of searchPath.split(delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate, platform)) return candidate;
  }
  return undefined;
}

/**
 * Whether `auth status`'s output says signed in. It exits non-zero when signed
 * out, so it's the output that's read, whatever the exit code.
 */
export function isSignedIn(authStatusOutput: string): boolean {
  try {
    const { loggedIn } = JSON.parse(authStatusOutput) as { loggedIn?: unknown };
    return loggedIn === true;
  } catch {
    return false;
  }
}

/** Finds Claude Code and asks it whether it's signed in. */
export async function claudeStatus(searchPath: string): Promise<ClaudeStatus> {
  const claudePath = findClaude(searchPath);
  if (!claudePath) return { state: "missing" };
  const output = await new Promise<string>((resolve) => {
    execFile(
      claudePath,
      ["auth", "status"],
      { timeout: 30_000, windowsHide: true },
      (_error, stdout) => resolve(stdout),
    );
  });
  return isSignedIn(output)
    ? { state: "ready", claudePath }
    : { state: "signedOut", claudePath };
}

/** Anthropic's installer for this platform, as a program and its arguments. */
export function installerCommand(
  platform: NodeJS.Platform = process.platform,
): {
  program: string;
  args: string[];
} {
  if (platform === "win32") {
    return {
      program: "powershell.exe",
      args: [
        ...["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"],
        "irm https://claude.ai/install.ps1 | iex",
      ],
    };
  }
  return {
    program: "/bin/bash",
    args: ["-c", "curl -fsSL https://claude.ai/install.sh | bash"],
  };
}

/**
 * Runs a Claude Code setup program, passing on each line it prints, until it
 * ends. `kill` on the returned child stops it.
 */
export function runSetupStep(
  program: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  onLine: (line: string) => void,
): { child: ChildProcess; finished: Promise<number | null> } {
  const child = spawn(program, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const forward = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (line.trim()) onLine(line);
    }
  };
  child.stdout.on("data", forward);
  child.stderr.on("data", forward);
  const finished = new Promise<number | null>((resolve) => {
    child.on("error", (error) => {
      onLine(error.message);
      resolve(null);
    });
    child.on("close", resolve);
  });
  return { child, finished };
}
