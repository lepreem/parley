import { MAX_DICTATION_BYTES } from "@parley/contract/limits";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockTranscribeDictation } = vi.hoisted(() => ({
  mockTranscribeDictation: vi.fn(),
}));

vi.mock("../../src/db", async () => ({
  db: {},
  ...(await import("../helpers/dbTableStubs")).tableStubs,
}));

vi.mock("../../src/ai/ai_transcribe_client/dictation", () => ({
  transcribeDictation: mockTranscribeDictation,
}));

import { createApp } from "../../src/app";
import { RATE_LIMIT_POLICIES } from "../../src/rateLimit/policies";
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import { authedHeaders, guestCookieHeader } from "../helpers/session";

const clip = new Uint8Array([1, 2, 3]);

async function post(
  headers: Record<string, string>,
  body: Uint8Array = clip,
  type = "audio/webm;codecs=opus",
) {
  return (await createApp()).request("http://localhost/speech/transcribe", {
    method: "POST",
    headers: { "Content-Type": type, ...headers },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  mockTranscribeDictation.mockResolvedValue("Hello there.");
});

describe("POST /speech/transcribe", () => {
  it("answers with what was said", async () => {
    const res = await post(await authedHeaders("user_01"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "Hello there." });
    expect(mockTranscribeDictation).toHaveBeenCalledWith(
      clip,
      "audio/webm;codecs=opus",
    );
  });

  it("takes a recording past the 1 MB every other route is held to", async () => {
    const res = await post(
      await authedHeaders("user_01"),
      new Uint8Array(MAX_DICTATION_BYTES),
    );

    expect(res.status).toBe(200);
  });

  it("refuses one over its own limit, without paying for it", async () => {
    const res = await post(
      await authedHeaders("user_01"),
      new Uint8Array(MAX_DICTATION_BYTES + 1),
    );

    expect(res.status).toBe(413);
    expect(mockTranscribeDictation).not.toHaveBeenCalled();
  });

  it("still holds other routes to 1 MB", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/conversations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await authedHeaders("user_01")),
      },
      body: new Uint8Array(2 * 1024 * 1024),
    });

    expect(res.status).toBe(413);
  });

  it("refuses someone not signed in", async () => {
    const res = await post({ Origin: process.env.CLIENT_URL! });

    expect(res.status).toBe(401);
    expect(mockTranscribeDictation).not.toHaveBeenCalled();
  });

  it("refuses guests", async () => {
    const res = await post({
      Origin: process.env.CLIENT_URL!,
      Cookie: await guestCookieHeader(
        "guest_00000000-0000-4000-8000-000000000002",
      ),
    });

    expect(res.status).toBe(403);
    expect(mockTranscribeDictation).not.toHaveBeenCalled();
  });

  it("refuses anything that isn't audio", async () => {
    const res = await post(
      await authedHeaders("user_01"),
      clip,
      "application/octet-stream",
    );

    expect(res.status).toBe(415);
  });

  it("stops a user at the short budget", async () => {
    const app = await createApp();
    const headers = await authedHeaders("user_budget");
    const send = () =>
      app.request("http://localhost/speech/transcribe", {
        method: "POST",
        headers: { "Content-Type": "audio/webm", ...headers },
        body: clip,
      });

    for (let i = 0; i < RATE_LIMIT_POLICIES.dictation.limit; i++) {
      expect((await send()).status).toBe(200);
    }
    expect((await send()).status).toBe(429);
  });
});
