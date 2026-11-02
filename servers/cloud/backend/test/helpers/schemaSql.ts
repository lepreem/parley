import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { MIGRATIONS_FOLDER } from "../../scripts/migrations";

/**
 * Migrations written by hand for what schema.ts can't express, so `drizzle-kit
 * export` leaves them out.
 */
export const HANDWRITTEN_MIGRATIONS = [
  "0004_immutable_messages",
  "0005_tolerate_owner_change",
];

/**
 * The SQL that creates src/db/schema.ts's tables, from `drizzle-kit
 * export`, and the handwritten migrations' triggers on them, for the
 * integration suites to run in their own schema.
 *
 * drizzle-kit's bin.cjs isn't an exported path, and the npm workspace
 * installs drizzle-kit at the repo root rather than in this package, so it's
 * found beside the package's main entry instead of at a fixed path.
 */
export function exportSchemaSql(): string {
  const require = createRequire(import.meta.url);
  const bin = path.join(
    path.dirname(require.resolve("drizzle-kit")),
    "bin.cjs",
  );
  const tables = execFileSync(
    process.execPath,
    [
      bin,
      "export",
      "--dialect",
      "postgresql",
      "--schema",
      "./src/db/schema.ts",
    ],
    { encoding: "utf8" },
  );
  const handwritten = HANDWRITTEN_MIGRATIONS.map((tag) =>
    fs.readFileSync(`${MIGRATIONS_FOLDER}/${tag}.sql`, "utf8"),
  );
  return [tables, ...handwritten].join("\n");
}
