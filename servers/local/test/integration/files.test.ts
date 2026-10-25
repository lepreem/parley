import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// A DATA_DIR of its own: removeOrphans clears out whatever it doesn't know
// about, which in the run's shared one would include other files' uploads.
const dataDirs = vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const shared = process.env.DATA_DIR;
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "parley-files-"));
  return { shared, own: process.env.DATA_DIR };
});

import { files } from "../../core/files";

afterAll(async () => {
  const { shared, own } = await dataDirs;
  process.env.DATA_DIR = shared;
  rmSync(own, { recursive: true, force: true });
});

const image = () => ({ kind: "image" as const, uploadId: randomUUID() });

describe("files", () => {
  it("reads back what it wrote, under DATA_DIR by kind and id", async () => {
    const file = image();
    await files.write(file, new TextEncoder().encode("pixels"));

    expect((await files.read(file)).toString()).toBe("pixels");
    expect(files.path(file)).toBe(
      path.join((await dataDirs).own, "images", file.uploadId),
    );
  });

  it("deletes files, and doesn't mind one that's already gone", async () => {
    const [kept, deleted] = [image(), image()];
    await files.write(kept, new Uint8Array([1]));
    await files.write(deleted, new Uint8Array([2]));

    await files.delete([deleted, image()]);

    await expect(files.read(deleted)).rejects.toThrow();
    expect(await files.read(kept)).toHaveLength(1);
  });

  it("refuses an id that isn't a UUID, so it can't name a path elsewhere", () => {
    expect(() =>
      files.path({ kind: "image", uploadId: "../../outside" }),
    ).toThrow("Not an upload id");
  });

  it("removes the files no row uses, and only those", async () => {
    const used = image();
    const orphans = [
      image(),
      { kind: "audio" as const, uploadId: randomUUID() },
    ];
    for (const file of [used, ...orphans]) {
      await files.write(file, new Uint8Array([0]));
    }
    // What the earlier cases left counts as in use too.
    const earlier = await import("node:fs/promises").then(({ readdir }) =>
      readdir(path.join(process.env.DATA_DIR!, "images")),
    );
    const inUse = new Set(
      earlier.filter((name) => name !== orphans[0].uploadId),
    );

    expect(await files.removeOrphans(inUse)).toBe(2);

    expect(await files.read(used)).toHaveLength(1);
    for (const orphan of orphans) {
      await expect(files.read(orphan)).rejects.toThrow();
    }
  });
});
