import fs from "node:fs";
import { getTableName, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import { MIGRATIONS_FOLDER } from "../../scripts/migrations";
import { HANDWRITTEN_MIGRATIONS } from "../helpers/schemaSql";

const tables = Object.values(schema).filter((value) => is(value, PgTable));

/**
 * A message and every row that belongs to it: tables with a foreign key to
 * chat_messages, and to those, however deep. Transcripts too, which messages
 * reach through an attachment rather than a key of their own.
 */
function writtenOnceTables(): string[] {
  const found = new Set<string>([
    getTableName(schema.ChatMessages),
    getTableName(schema.TranscriptContents),
  ]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const table of tables) {
      const name = getTableName(table);
      const references = getTableConfig(table).foreignKeys.map((key) =>
        getTableName(key.reference().foreignTable),
      );
      if (!found.has(name) && references.some((ref) => found.has(ref))) {
        found.add(name);
        grew = true;
      }
    }
  }
  return [...found].sort();
}

/** Each migration that makes a refuse-update trigger, and the tables it's on. */
function refuseUpdateTriggers(): Map<string, string[]> {
  const triggers = new Map<string, string[]>();
  for (const file of fs.readdirSync(MIGRATIONS_FOLDER)) {
    if (!file.endsWith(".sql")) continue;
    const sql = fs.readFileSync(`${MIGRATIONS_FOLDER}/${file}`, "utf8");
    const on = [
      ...sql.matchAll(
        /CREATE TRIGGER "\w+" BEFORE UPDATE ON "(\w+)"\s+FOR EACH ROW EXECUTE FUNCTION "refuse_update"/g,
      ),
    ].map((match) => match[1]!);
    if (on.length > 0) triggers.set(file.replace(/\.sql$/, ""), on);
  }
  return triggers;
}

// The history text cache keeps message and transcript text by id, so neither
// may change once written; an edit deletes rows and inserts new ones. A new
// table that hangs off a message is part of it, and gets the trigger too:
//   CREATE TRIGGER "<table>_immutable" BEFORE UPDATE ON "<table>"
//     FOR EACH ROW EXECUTE FUNCTION "refuse_update"();
// in a migration from `npm run db:generate -- --custom --name <name>`.
describe("written-once tables", () => {
  it("each refuse updates", () => {
    const guarded = new Set([...refuseUpdateTriggers().values()].flat());

    expect(writtenOnceTables().filter((name) => !guarded.has(name))).toEqual(
      [],
    );
  });

  // drizzle-kit export leaves triggers out, so the integration suites add
  // these migrations themselves.
  it("are guarded in the integration suites too", () => {
    expect([...refuseUpdateTriggers().keys()].sort()).toEqual(
      [...HANDWRITTEN_MIGRATIONS].sort(),
    );
  });
});
