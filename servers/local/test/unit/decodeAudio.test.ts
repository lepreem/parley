import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeAudio, pingFfmpeg } from "../../core/ai/decodeAudio";

// The real ffmpeg, the one ffmpeg-static installed for this platform.
const SAMPLE = fileURLToPath(
  new URL("../sample/audio_speech.flac", import.meta.url),
);

describe("decodeAudio", () => {
  it("decodes a file to 16kHz mono 16-bit PCM", async () => {
    const pcm = await decodeAudio(SAMPLE);

    // A few seconds of speech, two bytes a sample.
    expect(pcm.length % 2).toBe(0);
    expect(pcm.length / 2 / 16_000).toBeGreaterThan(1);
    expect(pcm.some((byte) => byte !== 0)).toBe(true);
  });

  it("fails with what ffmpeg said about a file that isn't audio", async () => {
    const notAudio = path.join(tmpdir(), "parley-not-audio.txt");
    await writeFile(notAudio, "hello");

    await expect(decodeAudio(notAudio)).rejects.toMatchObject({
      name: "AudioDecodeError",
      message: expect.stringContaining("Invalid data"),
    });
  });

  it("stops with the signal's reason when aborted", async () => {
    const reason = new Error("stop");

    await expect(decodeAudio(SAMPLE, AbortSignal.abort(reason))).rejects.toBe(
      reason,
    );
  });
});

describe("pingFfmpeg", () => {
  it("passes when ffmpeg runs", async () => {
    await expect(pingFfmpeg()).resolves.toBeUndefined();
  });
});
