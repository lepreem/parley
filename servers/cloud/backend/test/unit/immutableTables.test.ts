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

type RefuseUpdateTrigger = { table: string; tolerated: string[] };

/**
 * Each migration that makes a refuse-update trigger, oldest first, and the
 * triggers it makes: the table, and the columns the trigger's arguments
 * tolerate changes to.
 */
function refuseUpdateTriggers(): Map<string, RefuseUpdateTrigger[]> {
  const triggers = new Map<string, RefuseUpdateTrigger[]>();
  for (const file of fs.readdirSync(MIGRATIONS_FOLDER).sort()) {
    if (!file.endsWith(".sql")) continue;
    const sql = fs.readFileSync(`${MIGRATIONS_FOLDER}/${file}`, "utf8");
    const made = [
      ...sql.matchAll(
        /CREATE TRIGGER "\w+" BEFORE UPDATE ON "(\w+)"\s+FOR EACH ROW EXECUTE FUNCTION "refuse_update"\(([^)]*)\)/g,
      ),
    ].map((match) => ({
      table: match[1]!,
      tolerated: [...match[2]!.matchAll(/'(\w+)'/g)].map((arg) => arg[1]!),
    }));
    if (made.length > 0) triggers.set(file.replace(/\.sql$/, ""), made);
  }
  return triggers;
}

/** What each table's trigger tolerates now: its latest migration says. */
function toleratedColumns(): Record<string, string[]> {
  const tolerated: Record<string, string[]> = {};
  for (const made of refuseUpdateTriggers().values())
    for (const { table, tolerated: columns } of made)
      tolerated[table] = columns;
  return tolerated;
}

/**
 * The only columns a written-once row may change. Each is a decision: it
 * must leave the row's text as it was, which the history text cache keeps by
 * id. A table not listed tolerates nothing.
 */
const TOLERATED_UPDATES: Record<string, string[]> = {
  // A guest's messages move to the account they sign in to (users.adoptGuest).
  chat_messages: ["user_id"],
};

// The history text cache keeps message and transcript text by id, so neither
// may change once written; an edit deletes rows and inserts new ones. A new
// table that hangs off a message is part of it, and gets the trigger too:
//   CREATE TRIGGER "<table>_immutable" BEFORE UPDATE ON "<table>"
//     FOR EACH ROW EXECUTE FUNCTION "refuse_update"();
// in a migration from `npm run db:generate -- --custom --name <name>`.
describe("written-once tables", () => {
  it("each refuse updates", () => {
    const guarded = new Set(
      [...refuseUpdateTriggers().values()].flat().map(({ table }) => table),
    );

    expect(writtenOnceTables().filter((name) => !guarded.has(name))).toEqual(
      [],
    );
  });

  it("tolerate only the columns listed here", () => {
    const expected = Object.fromEntries(
      writtenOnceTables().map((table) => [
        table,
        TOLERATED_UPDATES[table] ?? [],
      ]),
    );

    expect(toleratedColumns()).toEqual(expected);
  });

  // drizzle-kit export leaves triggers out, so the integration suites add
  // these migrations themselves.
  it("are guarded in the integration suites too", () => {
    expect([...refuseUpdateTriggers().keys()].sort()).toEqual(
      [...HANDWRITTEN_MIGRATIONS].sort(),
    );
  });
});
