import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * One throwaway DATA_DIR for the whole run. Importing core/db opens a
 * database there; tests that query mock it with their own in-memory one. Set
 * before the workers start, so each inherits it.
 */
export default function setup() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "parley-test-"));
  process.env.DATA_DIR = dataDir;
  return () => rmSync(dataDir, { recursive: true, force: true });
}
