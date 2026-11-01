import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBaseEnv } from "../../core/env";
import { modelFile } from "../../core/ai/modelFiles";

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const modelsDir = () => path.join(getBaseEnv().DATA_DIR, "models");

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** A model named `name` whose file holds `weights`. */
const model = (name: string, weights = "weights") => ({
  name,
  url: `https://example.com/${name}`,
  sha256: sha256(weights),
});

describe("modelFile", () => {
  it("downloads a model into DATA_DIR/models, once", async () => {
    mockFetch.mockResolvedValue(new Response("weights"));

    const first = await modelFile(model("ggml-a.bin"));
    const second = await modelFile(model("ggml-a.bin"));

    expect(first).toBe(path.join(modelsDir(), "ggml-a.bin"));
    expect(second).toBe(first);
    expect(await readFile(first, "utf8")).toBe("weights");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[0]).toBe("https://example.com/ggml-a.bin");
  });

  it("fails on an error status, leaving nothing behind", async () => {
    mockFetch.mockResolvedValue(new Response("gone", { status: 404 }));

    await expect(modelFile(model("ggml-b.bin"))).rejects.toThrow(
      "Downloading ggml-b.bin failed: HTTP 404",
    );
    expect(
      (await readdir(modelsDir())).filter((name) => name.includes("ggml-b")),
    ).toEqual([]);
  });

  it("leaves nothing behind when the download breaks off", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("half"));
        controller.error(new Error("connection reset"));
      },
    });
    mockFetch.mockResolvedValue(new Response(body));

    await expect(modelFile(model("ggml-c.bin"))).rejects.toThrow(
      "connection reset",
    );
    expect(
      (await readdir(modelsDir())).filter((name) => name.includes("ggml-c")),
    ).toEqual([]);
  });

  it("throws away a download that isn't the file expected", async () => {
    mockFetch.mockResolvedValue(new Response("tampered"));

    await expect(modelFile(model("ggml-d.bin", "weights"))).rejects.toThrow(
      `Downloaded ggml-d.bin isn't the file expected: sha256 ${sha256("tampered")}, not ${sha256("weights")}`,
    );
    expect(
      (await readdir(modelsDir())).filter((name) => name.includes("ggml-d")),
    ).toEqual([]);
  });
});
