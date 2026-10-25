import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getBaseEnv } from "./env";

/**
 * The files uploads and YouTube fetches leave, under DATA_DIR: one folder per
 * kind, one file per upload, named by its id. The row that references a file
 * is what says it's in use; removeOrphans clears out the rest.
 */
const FOLDERS = { image: "images", audio: "audios" } as const;

type FileKind = keyof typeof FOLDERS;
type StoredFile = { kind: FileKind; uploadId: string };

/** The largest image an upload may be. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * The largest audio file an upload or a YouTube fetch may leave. Kept from the
 * hosted app, where Supabase's free plan capped uploads at 50 MB; nothing
 * local requires it.
 */
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where a file lives. The id becomes a file name, so anything but a UUID is
 * refused rather than allowed to point somewhere else.
 */
function pathOf({ kind, uploadId }: StoredFile) {
  if (!UUID.test(uploadId)) throw new Error(`Not an upload id: ${uploadId}`);
  return path.join(getBaseEnv().DATA_DIR, FOLDERS[kind], uploadId);
}

async function write(file: StoredFile, bytes: Uint8Array) {
  const filePath = pathOf(file);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
}

async function read(file: StoredFile) {
  return readFile(pathOf(file));
}

/** Removes files; one that's already gone is no error. */
async function deleteFiles(files: readonly StoredFile[]) {
  await Promise.all(files.map((file) => rm(pathOf(file), { force: true })));
}

/**
 * Removes every file whose id isn't in `inUse`: what a crash left between
 * writing a file and its row, or between deleting a row and its file, and
 * what a YouTube fetch wrote for a job deleted while it ran. Runs at startup,
 * before anything can write.
 */
async function removeOrphans(inUse: ReadonlySet<string>) {
  let removed = 0;
  for (const kind of Object.keys(FOLDERS) as FileKind[]) {
    const folder = path.join(getBaseEnv().DATA_DIR, FOLDERS[kind]);
    const names = await readdir(folder).catch(() => []);
    const orphans = names.filter((name) => !inUse.has(name));
    await Promise.all(
      orphans.map((name) => rm(path.join(folder, name), { force: true })),
    );
    removed += orphans.length;
  }
  return removed;
}

export const files = {
  path: pathOf,
  write,
  read,
  delete: deleteFiles,
  removeOrphans,
};
