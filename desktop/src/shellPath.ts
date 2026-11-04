import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

const MARKER = "__PARLEY_PATH__";

/**
 * Where the official installers and the usual package managers put programs.
 * Checked even when the login shell doesn't list them, since one that has just
 * installed Claude Code hasn't been restarted.
 */
function wellKnownDirs(home: string, platform: NodeJS.Platform): string[] {
  const local = path.join(home, ".local", "bin");
  if (platform === "win32") return [local];
  return [local, "/opt/homebrew/bin", "/usr/local/bin"];
}

/** The PATH printed between the markers, if the output has it. */
export function pathFromShellOutput(output: string): string | undefined {
  return output.split(MARKER)[1];
}

/** `dirs`, each once, in order, ignoring empty entries. */
export function joinPath(
  dirs: readonly string[],
  delimiter: string = path.delimiter,
): string {
  return [...new Set(dirs.filter(Boolean))].join(delimiter);
}

/**
 * The PATH the user has in their terminal. An app opened from the Finder or a
 * desktop launcher doesn't get it, only a bare system one, which is why a
 * program the terminal finds can look missing. The shell runs as login and
 * interactive because that's where people's profiles add to PATH; a profile
 * that hangs or prints noise costs the timeout or nothing.
 */
function loginShellPath(): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      process.env.SHELL ?? "/bin/zsh",
      ["-ilc", `printf '${MARKER}%s${MARKER}' "$PATH"`],
      { timeout: 5_000 },
      (_error, stdout) => resolve(pathFromShellOutput(stdout) ?? ""),
    );
  });
}

/** The PATH to find Claude Code on and to run the server with. */
export async function userPath(): Promise<string> {
  const inherited = process.env.PATH ?? "";
  const dirs = wellKnownDirs(homedir(), process.platform);
  if (process.platform === "win32") {
    return joinPath([...inherited.split(path.delimiter), ...dirs]);
  }
  const shell = await loginShellPath();
  return joinPath([
    ...shell.split(path.delimiter),
    ...inherited.split(path.delimiter),
    ...dirs,
  ]);
}
