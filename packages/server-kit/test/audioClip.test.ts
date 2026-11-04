import { MAX_DICTATION_BYTES } from "@parley/contract/limits";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { audioClipBody, audioClipLimit } from "../src/http/audioClip";

const app = new Hono<{ Variables: { audioClip: Uint8Array<ArrayBuffer> } }>();
app.post("/clip", audioClipLimit, audioClipBody, (c) =>
  c.json({ bytes: c.var.audioClip.length }),
);

const post = (body: Uint8Array | null, type = "audio/webm;codecs=opus") =>
  app.request("/clip", {
    method: "POST",
    headers: { "Content-Type": type },
    ...(body ? { body: body as Uint8Array<ArrayBuffer> } : {}),
  });

describe("audioClipBody", () => {
  it("hands the recording on", async () => {
    const response = await post(new Uint8Array(1234));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: 1234 });
  });

  it("refuses anything that isn't audio", async () => {
    const response = await post(new Uint8Array(10), "application/json");

    expect(response.status).toBe(415);
  });

  it("refuses an empty recording", async () => {
    expect((await post(null)).status).toBe(400);
  });

  it("accepts a recording exactly at the limit", async () => {
    const response = await post(new Uint8Array(MAX_DICTATION_BYTES));

    expect(response.status).toBe(200);
  });

  it("refuses one over the limit", async () => {
    const response = await post(new Uint8Array(MAX_DICTATION_BYTES + 1));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      message: "That recording is too long",
    });
  });
});
