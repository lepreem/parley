import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeDictation } from "../../src/ai/ai_transcribe_client/dictation";

const clip = new Uint8Array([1, 2, 3]);

function answering(status: number, body: unknown) {
  const fetchMock = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("transcribeDictation", () => {
  it("sends the recording to Whisper, named for its type", async () => {
    const fetchMock = answering(200, { text: "Hello." });

    await transcribeDictation(clip, "audio/webm;codecs=opus");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/audio\/transcriptions$/);
    const form = init!.body as FormData;
    expect(form.get("model")).toBe("openai/whisper-large-v3-turbo");
    const file = form.get("file") as File;
    expect(file.name).toBe("recording.webm");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(clip);
  });

  it("names Safari's recordings mp4", async () => {
    const fetchMock = answering(200, { text: "Hello." });

    await transcribeDictation(clip, "audio/mp4");

    const form = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect((form.get("file") as File).name).toBe("recording.mp4");
  });

  it("tidies the spacing Whisper leaves", async () => {
    answering(200, { text: " One sentence?  Another one." });

    expect(await transcribeDictation(clip, "audio/webm")).toBe(
      "One sentence? Another one.",
    );
  });

  it("answers empty when nobody spoke", async () => {
    answering(200, { text: "" });

    expect(await transcribeDictation(clip, "audio/webm")).toBe("");
  });

  it("throws when OpenRouter refuses", async () => {
    answering(402, { error: { message: "Insufficient credits" } });

    await expect(transcribeDictation(clip, "audio/webm")).rejects.toThrow(
      "HTTP 402",
    );
  });
});
