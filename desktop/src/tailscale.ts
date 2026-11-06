import { execFile, spawn } from "node:child_process";

/** Where Tailscale's own app keeps the command when it isn't on the PATH. */
const INSTALLED_PROGRAMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  win32: "C:\\Program Files\\Tailscale\\tailscale.exe",
};

const STATUS_TIMEOUT_MS = 10_000;
/** The end of what `tailscale serve` printed, shown when it fails. */
const KEPT_OUTPUT_CHARS = 4_000;

export type TailscaleStatus =
  | { state: "missing" | "signedOut" | "tagged" }
  | { state: "ready"; program: string; hostname: string; login: string };

type StatusJson = {
  BackendState?: string;
  Self?: { DNSName?: string; UserID?: number; Tags?: string[] };
  User?: Record<string, { LoginName?: string }>;
};

/** What `tailscale status --json` says about this machine. */
export function parseStatus(json: string, program: string): TailscaleStatus {
  let status: StatusJson;
  try {
    status = JSON.parse(json) as StatusJson;
  } catch {
    return { state: "signedOut" };
  }
  if (status.BackendState !== "Running") return { state: "signedOut" };
  // A tagged machine belongs to no one, so Tailscale names no account for it.
  if (status.Self?.Tags?.length) return { state: "tagged" };
  const hostname = status.Self?.DNSName?.replace(/\.$/, "").toLowerCase();
  const login = status.User?.[String(status.Self?.UserID)]?.LoginName;
  if (!hostname || !login) return { state: "signedOut" };
  return { state: "ready", program, hostname, login };
}

function runStatus(
  program: string,
  searchPath: string,
): Promise<{ stdout: string } | { missing: true }> {
  return new Promise((resolve) => {
    execFile(
      program,
      ["status", "--json"],
      {
        env: { ...process.env, PATH: searchPath },
        timeout: STATUS_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolve(code === "ENOENT" ? { missing: true } : { stdout });
      },
    );
  });
}

/** Finds Tailscale and reads this machine's state from it. */
export async function readTailscale(
  searchPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<TailscaleStatus> {
  const installed = INSTALLED_PROGRAMS[platform];
  for (const program of ["tailscale", ...(installed ? [installed] : [])]) {
    const result = await runStatus(program, searchPath);
    // A daemon that isn't running fails with no output, which reads as signed
    // out: either way, opening Tailscale is what fixes it.
    if ("stdout" in result) return parseStatus(result.stdout, program);
  }
  return { state: "missing" };
}

/** Where Tailscale says to allow HTTPS for the tailnet, if the output has it. */
export function enableHttpsUrl(output: string): string | undefined {
  return /https:\/\/login\.tailscale\.com\/\S+/.exec(output)?.[0];
}

export function isServing(output: string): boolean {
  return output.includes("Available within your tailnet");
}

export type Serve = { stop(): void };

/**
 * Puts the port behind this machine's Tailscale name, on HTTPS, for the tailnet
 * only. It runs in the foreground, the opposite of the `--bg` a person would
 * use: when the program ends, so does the serving, whatever ended it.
 */
export function startServe(
  program: string,
  port: number,
  searchPath: string,
  onOutput: (output: string) => void,
  onExit: (code: number | null, output: string) => void,
): Serve {
  const child = spawn(program, ["serve", String(port)], {
    env: { ...process.env, PATH: searchPath },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-KEPT_OUTPUT_CHARS);
    onOutput(output);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  // Either can come first or alone, and the caller hears of one.
  let exited = false;
  const exit = (code: number | null) => {
    if (exited) return;
    exited = true;
    onExit(code, output);
  };
  child.once("error", (error) => {
    output += `\n${error.message}`;
    exit(null);
  });
  child.once("close", exit);
  return { stop: () => void child.kill() };
}
