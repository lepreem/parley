import fs from "node:fs";
import { getTableName, is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import * as schema from "../../core/db/schema";

const MIGRATIONS_FOLDER = "./drizzle";

const tables = Object.values(schema).filter((value) => is(value, SQLiteTable));

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

/** The tables the migrations give a refuse-update trigger. */
function guardedTables(): Set<string> {
  const guarded = new Set<string>();
  for (const file of fs.readdirSync(MIGRATIONS_FOLDER)) {
    if (!file.endsWith(".sql")) continue;
    const sql = fs.readFileSync(`${MIGRATIONS_FOLDER}/${file}`, "utf8");
    for (const match of sql.matchAll(
      /CREATE TRIGGER `\w+` BEFORE UPDATE ON `(\w+)`\s+BEGIN\s+SELECT RAISE\(ABORT, '\1 rows are immutable/g,
    )) {
      guarded.add(match[1]!);
    }
  }
  return guarded;
}

// Message and transcript text are written once; an edit deletes rows and
// inserts new ones. A new table that hangs off a message is part of it, and
// gets the trigger too:
//   CREATE TRIGGER `<table>_immutable` BEFORE UPDATE ON `<table>`
//   BEGIN
//     SELECT RAISE(ABORT, '<table> rows are immutable: delete and insert instead');
//   END;
// in a migration from `npx drizzle-kit generate --custom --name <name>`.
describe("written-once tables", () => {
  it("each refuse updates", () => {
    const guarded = guardedTables();

    expect(writtenOnceTables().filter((name) => !guarded.has(name))).toEqual(
      [],
    );
  });
});
