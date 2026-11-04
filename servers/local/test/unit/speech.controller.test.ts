import { existsSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDictateAI } = vi.hoisted(() => ({ mockDictateAI: vi.fn() }));
vi.mock("../../core/ai/ai_transcribe_client", () => ({
  dictateAI: mockDictateAI,
}));

import { speechRouter } from "../../api/src/routes/speech.router";

const app = new Hono();
app.route("/speech", speechRouter);

const post = () =>
  app.request("/speech/transcribe", {
    method: "POST",
    headers: { "Content-Type": "audio/webm" },
    body: new Uint8Array([1, 2, 3]),
  });

beforeEach(() => {
  mockDictateAI.mockReset();
});

describe("POST /speech/transcribe", () => {
  it("transcribes the recording and answers with the text", async () => {
    let sawBytes: number[] = [];
    mockDictateAI.mockImplementation(async (audioPath: string) => {
      sawBytes = [...readFileSync(audioPath)];
      return "Hello.";
    });

    const response = await post();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "Hello." });
    expect(sawBytes).toEqual([1, 2, 3]);
  });

  it("leaves no file behind, even when transcription fails", async () => {
    let audioPath = "";
    mockDictateAI.mockImplementation(async (path: string) => {
      audioPath = path;
      throw new Error("whisper broke");
    });

    const response = await post();

    expect(response.status).toBe(500);
    expect(audioPath).not.toBe("");
    expect(existsSync(audioPath)).toBe(false);
  });
});
