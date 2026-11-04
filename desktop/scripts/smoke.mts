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
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEBUG_PORT = 9333;
const SAMPLE = path.resolve("../servers/local/test/sample/audio_speech.flac");
const EXPECTED_WORDS = /ask not/i;
const PAGE_TIMEOUT_MS = 3 * 60_000;
const TRANSCRIBE_TIMEOUT_MS = 30 * 60_000;

function appBinary(): string {
  const release = path.resolve("release");
  const candidates = {
    darwin: [
      `mac-${process.arch}/Parley.app/Contents/MacOS/Parley`,
      "mac/Parley.app/Contents/MacOS/Parley",
    ],
    win32: ["win-unpacked/Parley.exe"],
    linux: [`linux-${process.arch}-unpacked/parley`, "linux-unpacked/parley"],
  }[process.platform as "darwin" | "win32" | "linux"];
  for (const candidate of candidates) {
    const file = path.join(release, candidate);
    if (existsSync(file)) return file;
  }
  throw new Error(`No packaged app in ${release}: ${candidates.join(", ")}`);
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

const scratch = await mkdtemp(path.join(tmpdir(), "parley-smoke-"));
await fakeClaude(scratch);

const app = spawn(
  appBinary(),
  [
    `--remote-debugging-port=${DEBUG_PORT}`,
    // An unpacked Linux app's sandbox helper isn't set up the way an installed
    // one's is.
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
  ],
  {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      DATA_DIR: path.join(scratch, "data"),
      PATH: `${scratch}${path.delimiter}${process.env.PATH ?? ""}`,
      ELECTRON_RUN_AS_NODE: "",
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
} finally {
  app.kill();
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
process.exit(failed ? 1 : 0);
