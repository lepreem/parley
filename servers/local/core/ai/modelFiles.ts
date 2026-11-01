import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { getBaseEnv } from "../env";

/** Where models are kept once downloaded. */
function modelsDir() {
  return path.join(getBaseEnv().DATA_DIR, "models");
}

/** A model file, and where to get it. */
export interface ModelSource {
  name: string;
  url: string;
  /** The file's sha256, in hex. A download that doesn't match is thrown away. */
  sha256: string;
}

/**
 * The path of the model file `name`, downloaded from `url` the first time it's
 * asked for. The download goes to a file of its own and is renamed into place
 * once complete and checked against `sha256`, so an interrupted one, two at
 * once, or one that isn't the file expected, never leave a model under the
 * real name.
 */
export async function modelFile(
  { name, url, sha256 }: ModelSource,
  abortSignal?: AbortSignal,
): Promise<string> {
  const target = path.join(modelsDir(), name);
  try {
    await access(target);
    return target;
  } catch {
    // Not downloaded yet.
  }

  await mkdir(modelsDir(), { recursive: true });
  const partial = `${target}.${randomUUID()}.part`;
  try {
    const response = await fetch(url, {
      ...(abortSignal ? { signal: abortSignal } : {}),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Downloading ${name} failed: HTTP ${response.status}`);
    }
    const hash = createHash("sha256");
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(partial),
      ...(abortSignal ? [{ signal: abortSignal }] : []),
    );
    const actual = hash.digest("hex");
    if (actual !== sha256) {
      throw new Error(
        `Downloaded ${name} isn't the file expected: sha256 ${actual}, not ${sha256}`,
      );
    }
    await rename(partial, target);
    return target;
  } finally {
    await rm(partial, { force: true });
  }
}
