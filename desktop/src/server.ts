import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { freePort } from "./ports";

/** How long the server gets to migrate and pass its checks before it's given up on. */
const START_TIMEOUT_MS = 3 * 60_000;
/** How long it gets to finish up when the app quits. */
const STOP_TIMEOUT_MS = 20_000;
const POLL_MS = 200;
/** The end of the server's output, shown when it fails to start. */
const KEPT_OUTPUT_CHARS = 4_000;

/** The server's own explanation of why it stopped, for the person to read. */
export class ServerStartError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
    this.name = "ServerStartError";
  }
}

export type ServerOptions = {
  /** The folder holding run.mjs, dist/ and drizzle/. */
  serverDir: string;
  clientDir: string;
  dataDir: string;
  claudePath: string;
  ytDlpPath: string;
  searchPath: string;
};

export type RunningServer = {
  url: string;
  port: number;
  /** Tells the server which name and account phone access answers, if any. */
  allowPhoneAccess(
    access: { hostname: string; login: string } | undefined,
  ): void;
  /** Resolves when the server has gone, for any reason. */
  exited: Promise<void>;
  stop(): Promise<void>;
};

/** Waits for /health to answer, or for `gone` to say the process ended. */
async function waitUntilHealthy(url: string, gone: () => boolean) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline && !gone()) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new ServerStartError(
    gone()
      ? "The server stopped while starting"
      : "The server took too long to start",
    "",
  );
}

/**
 * Starts the local server with this app's own Node: the Electron program, told
 * to run as plain Node. The variable stays set for what the server runs in
 * turn, because yt-dlp uses this same program as its JavaScript runtime.
 */
export async function startServer(
  options: ServerOptions,
): Promise<RunningServer> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;

  const logsDir = path.join(options.dataDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const log = createWriteStream(path.join(logsDir, "server.log"));

  const child: ChildProcess = spawn(
    process.execPath,
    [path.join(options.serverDir, "run.mjs")],
    {
      cwd: options.serverDir,
      // stdin stays open for as long as this app lives; see run.mjs.
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: "production",
        PATH: options.searchPath,
        PORT: String(port),
        DATA_DIR: options.dataDir,
        CLIENT_DIR: options.clientDir,
        CLAUDE_PATH: options.claudePath,
        YT_DLP_PATH: options.ytDlpPath,
      },
    },
  );

  let output = "";
  const keep = (chunk: Buffer) => {
    log.write(chunk);
    output = (output + chunk.toString("utf8")).slice(-KEPT_OUTPUT_CHARS);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);

  let gone = false;
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => {
      gone = true;
      log.end();
      resolve();
    });
    child.once("error", (error) => {
      output += `\n${error.message}`;
      gone = true;
      resolve();
    });
  });

  const stop = async () => {
    if (gone) return;
    child.stdin?.end();
    const timeout = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
    await exited;
    clearTimeout(timeout);
  };

  try {
    await waitUntilHealthy(url, () => gone);
  } catch (error) {
    await stop();
    throw new ServerStartError((error as Error).message, output);
  }
  return {
    url,
    port,
    allowPhoneAccess: (access) => {
      if (!child.connected) return;
      child.send({
        hostname: access?.hostname ?? null,
        login: access?.login ?? null,
      });
    },
    exited,
    stop,
  };
}
