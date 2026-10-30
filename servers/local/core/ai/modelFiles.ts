import { randomUUID } from "node:crypto";
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

/**
 * The path of the model file `name`, downloaded from `url` the first time it's
 * asked for. The download goes to a file of its own and is renamed into place
 * once complete, so an interrupted one, or two at once, never leave half a
 * model under the real name.
 */
export async function modelFile(
  name: string,
  url: string,
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
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream),
      createWriteStream(partial),
      ...(abortSignal ? [{ signal: abortSignal }] : []),
    );
    await rename(partial, target);
    return target;
  } finally {
    await rm(partial, { force: true });
  }
}
