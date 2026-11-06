import { execFile } from "node:child_process";
import { findOnPath } from "./claudeCode";

/**
 * Where Codex stands on this computer. Chat runs on it as well as, or instead
 * of, Claude Code; the app installs only Claude Code, so Codex counts once the
 * person has installed it and run `codex login`.
 */
export type CodexStatus =
  | { state: "missing" }
  | { state: "signedOut"; codexPath: string }
  | { state: "ready"; codexPath: string };

/** Finds Codex and asks it whether it's signed in. */
export async function codexStatus(searchPath: string): Promise<CodexStatus> {
  const codexPath = findOnPath(
    process.platform === "win32" ? "codex.exe" : "codex",
    searchPath,
  );
  if (!codexPath) return { state: "missing" };
  // It exits non-zero when signed out.
  const signedIn = await new Promise<boolean>((resolve) => {
    execFile(
      codexPath,
      ["login", "status"],
      { timeout: 30_000, windowsHide: true },
      (error) => resolve(!error),
    );
  });
  return signedIn
    ? { state: "ready", codexPath }
    : { state: "signedOut", codexPath };
}
