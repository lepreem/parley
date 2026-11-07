/**
 * Opens the packaged app and uses it the way a person would: waits for the chat
 * page, uploads a clip and reads the transcript back, then quits and checks the
 * server went with it. Everything real but Claude Code, which would need an
 * account: a stand-in answers its sign-in check.
 *
 * Downloads the Whisper model, so it takes a few minutes on first run. On
 * Linux without a display, run it under xvfb-run.
 */
import { spawn, execFileSync } from "node:child_process";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEBUG_PORT = 9333;
const SAMPLE = path.resolve("../servers/local/test/sample/audio_speech.flac");
const EXPECTED_WORDS = /ask not/i;
const PAGE_TIMEOUT_MS = 3 * 60_000;
const TRANSCRIBE_TIMEOUT_MS = 30 * 60_000;

/** The packaged app's folder, and its program inside that folder. */
function packagedApp(): { dir: string; binary: string } {
  const release = path.resolve("release");
  const candidates = {
    darwin: [
      {
        dir: `mac-${process.arch}/Parley.app`,
        binary: "Contents/MacOS/Parley",
      },
      { dir: "mac/Parley.app", binary: "Contents/MacOS/Parley" },
    ],
    win32: [{ dir: "win-unpacked", binary: "Parley.exe" }],
    linux: [
      { dir: `linux-${process.arch}-unpacked`, binary: "parley" },
      { dir: "linux-unpacked", binary: "parley" },
    ],
  }[process.platform as "darwin" | "win32" | "linux"];
  for (const { dir, binary } of candidates) {
    const full = path.join(release, dir);
    if (existsSync(path.join(full, binary))) return { dir: full, binary };
  }
  throw new Error(`No packaged app in ${release}`);
}

/** A `claude` that only knows how to say it's signed in. */
async function fakeClaude(dir: string) {
  const answer = '{"loggedIn":true}';
  if (process.platform !== "win32") {
    const file = path.join(dir, "claude");
    await writeFile(file, `#!/bin/sh\necho '${answer}'\n`);
    await chmod(file, 0o755);
    return;
  }
  // A real program: the server doesn't start scripts on Windows.
  const source = `public class P { static void Main() { System.Console.WriteLine("${answer.replaceAll('"', '\\"')}"); } }`;
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Add-Type -TypeDefinition '${source}' -OutputAssembly '${path.join(dir, "claude.exe")}' -OutputType ConsoleApplication`,
  ]);
}

async function poll<T>(
  what: string,
  timeoutMs: number,
  attempt: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await attempt().catch(() => undefined);
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** What the window is showing and what the server said, for a failed run. */
async function reportState(dataDir: string) {
  try {
    const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const pages = (await response.json()) as {
      url: string;
      webSocketDebuggerUrl: string;
    }[];
    for (const page of pages) {
      console.error(`The window shows ${page.url}`);
      const socket = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve) => (socket.onopen = resolve));
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression: "document.body.innerText" },
        }),
      );
      const answer = await new Promise<string>((resolve) => {
        socket.onmessage = (event) => resolve(String(event.data));
      });
      const { result } = JSON.parse(answer) as {
        result: { result: { value: string } };
      };
      console.error(result.result.value);
      socket.close();
    }
  } catch (error) {
    console.error("Couldn't read the window:", error);
  }
  const log = await readFile(
    path.join(dataDir, "logs", "server.log"),
    "utf8",
  ).catch(() => "(no server log)");
  console.error(log);
}

const scratch = await mkdtemp(path.join(tmpdir(), "parley-smoke-"));
await fakeClaude(scratch);
const dataDir = path.join(scratch, "data");

// Run from outside the repo, as a person would: from inside it, a package
// missing from the app would be found in the repo's own node_modules instead.
const packaged = packagedApp();
const installed = path.join(scratch, path.basename(packaged.dir));
await cp(packaged.dir, installed, { recursive: true, verbatimSymlinks: true });

const { ELECTRON_RUN_AS_NODE: _notForTheApp, ...parentEnv } = process.env;
const app = spawn(
  path.join(installed, packaged.binary),
  [
    `--remote-debugging-port=${DEBUG_PORT}`,
    // An unpacked Linux app's sandbox helper isn't set up the way an installed
    // one's is.
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
  ],
  {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...parentEnv,
      DATA_DIR: dataDir,
      PATH: `${scratch}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  },
);

let failed = false;
try {
  const page = await poll("the chat page", PAGE_TIMEOUT_MS, async () => {
    const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const pages = (await response.json()) as { url: string; title: string }[];
    return pages.find((candidate) =>
      candidate.url.startsWith("http://127.0.0.1"),
    );
  });
  const origin = new URL(page.url).origin;
  console.log(`The window shows ${page.url}`);

  const form = new FormData();
  form.append(
    "file",
    new File([await readFile(SAMPLE)], "sample.flac", { type: "audio/flac" }),
  );
  form.append("audioSource", "audio");
  const upload = await fetch(`${origin}/upload/audio`, {
    method: "POST",
    headers: { Origin: origin },
    body: form,
  });
  if (!upload.ok) {
    throw new Error(`Upload: ${upload.status} ${await upload.text()}`);
  }
  const { audioUploadId } = (await upload.json()) as { audioUploadId: string };

  const transcript = await poll(
    "the transcript",
    TRANSCRIBE_TIMEOUT_MS,
    async () => {
      const response = await fetch(
        `${origin}/jobs/transcribe/${audioUploadId}`,
      );
      const job = (await response.json()) as {
        status: string;
        transcript: string | null;
        error: string | null;
      };
      if (job.status === "failed") {
        failed = true;
        throw new Error(job.error ?? "failed");
      }
      return job.status === "completed" ? (job.transcript ?? "") : undefined;
    },
  );
  if (!EXPECTED_WORDS.test(transcript)) {
    throw new Error(`Unexpected transcript: ${transcript}`);
  }
  console.log(`Transcribed: ${transcript}`);

  app.kill();
  await poll("the server to stop", 45_000, async () => {
    try {
      await fetch(`${origin}/health`);
      return undefined;
    } catch {
      return true;
    }
  });
  console.log("Smoke test passed");
} catch (error) {
  failed = true;
  console.error(error);
  await reportState(dataDir);
} finally {
  app.kill();
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
process.exit(failed ? 1 : 0);
