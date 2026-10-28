import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeProcess, spawned, valueOf } from "../helpers/fakeProcess";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

import path from "node:path";
import {
  DEFAULT_TRANSCRIBE_MODEL,
  listTranscribeModels,
  isValidTranscribeModel,
  pingTranscribeAI,
  transcribeAI,
} from "../../core/ai/ai_transcribe_client";
import { getBaseEnv } from "../../core/env";

/** A segment as whisper.py prints it. */
const segment = (start: number, end: number, text: string) => ({
  line: { start, end, text },
});

const transcribe = () => transcribeAI("small", "/data/audios/talk");

beforeEach(() => {
  mockSpawn.mockReset();
});

describe("pingTranscribeAI", () => {
  it("has uv run the script's check", async () => {
    mockSpawn.mockImplementation(fakeProcess([]));

    await pingTranscribeAI();

    const { command, args } = spawned(mockSpawn);
    expect(command).toBe("uv");
    expect(args.slice(0, 3)).toEqual(["run", "--quiet", "--script"]);
    expect(path.basename(args[3] as string)).toBe("whisper.py");
    expect(args.slice(4)).toEqual(["--check"]);
  });

  it("fails with the exception Python ended on", async () => {
    mockSpawn.mockImplementation(
      fakeProcess([], {
        code: 1,
        stderr: "Traceback (most recent call last):\n  ...\nImportError: no\n",
      }),
    );

    await expect(pingTranscribeAI()).rejects.toThrow("ImportError: no");
  });
});

describe("transcribeAI", () => {
  it("transcribes the file with the model, keeping models in DATA_DIR", async () => {
    mockSpawn.mockImplementation(fakeProcess([segment(0, 2, " Hello.")]));

    expect(await transcribe()).toEqual([{ start: 0, end: 2, text: " Hello." }]);

    const { args } = spawned(mockSpawn);
    expect(valueOf(args, "--model")).toBe("small");
    expect(valueOf(args, "--models-dir")).toBe(
      path.join(getBaseEnv().DATA_DIR, "models"),
    );
    expect(args.at(-1)).toBe("/data/audios/talk");
  });

  it("answers every segment Whisper printed, in order", async () => {
    mockSpawn.mockImplementation(
      fakeProcess([segment(0, 2, " First."), segment(7, 9, " After a pause.")]),
    );

    expect(await transcribe()).toEqual([
      { start: 0, end: 2, text: " First." },
      { start: 7, end: 9, text: " After a pause." },
    ]);
  });

  it("is empty for audio with no speech", async () => {
    mockSpawn.mockImplementation(fakeProcess([]));

    expect(await transcribe()).toEqual([]);
  });

  it("fails with the whole exception, when its message runs over lines", async () => {
    mockSpawn.mockImplementation(
      fakeProcess([segment(0, 2, " Hello.")], {
        code: 1,
        stderr:
          "Traceback (most recent call last):\n  ...\nRuntimeError: Download failed:\nBlocked by network policy\n  detail: no matching allow rule\n",
      }),
    );

    await expect(transcribe()).rejects.toThrow(
      "RuntimeError: Download failed:\nBlocked by network policy\n  detail: no matching allow rule",
    );
  });

  it("fails with the last line of anything else it printed", async () => {
    mockSpawn.mockImplementation(
      fakeProcess([], {
        code: 2,
        stderr: "error: No such file\nhint: check it\n",
      }),
    );

    await expect(transcribe()).rejects.toThrow(/^hint: check it$/);
  });
});

describe("transcribeAI timeouts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const MINUTE = 60_000;

  it("waits for the model to download before the first segment", async () => {
    mockSpawn.mockImplementation(
      fakeProcess([{ afterMs: 29 * MINUTE, ...segment(0, 1, " Hi.") }]),
    );
    const result = transcribe();

    await vi.advanceTimersByTimeAsync(29 * MINUTE);
    expect(await result).toEqual([{ start: 0, end: 1, text: " Hi." }]);
  });

  it("gives up on a run that stalls between segments, and kills it", async () => {
    mockSpawn.mockImplementation(
      fakeProcess([segment(0, 1, " Hi.")], { end: false }),
    );
    const result = transcribe();
    const failed = expect(result).rejects.toMatchObject({
      name: "TimeoutError",
      message: "No progress for 600000 ms",
    });

    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await failed;
    expect(spawned(mockSpawn).options.signal?.aborted).toBe(true);
  });
});

describe("the model catalog", () => {
  it("lists the Whisper models by name", async () => {
    expect((await listTranscribeModels()).map((model) => model.id)).toEqual([
      "tiny",
      "base",
      "small",
      "medium",
      "large-v3-turbo",
      "large-v3",
    ]);
  });

  it("accepts a listed model, the default among them", async () => {
    expect(await isValidTranscribeModel(DEFAULT_TRANSCRIBE_MODEL)).toBe(true);
    expect(await isValidTranscribeModel("large-v3-turbo")).toBe(true);
  });

  it("refuses a model it doesn't list", async () => {
    expect(await isValidTranscribeModel("nova-3-general")).toBe(false);
  });
});
