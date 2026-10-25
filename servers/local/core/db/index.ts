import { mkdirSync } from "node:fs";
import path from "node:path";
import { getBaseEnv } from "../env";
import { openDatabase } from "./connect";

const databaseDirectory = path.join(getBaseEnv().DATA_DIR, "db");
mkdirSync(databaseDirectory, { recursive: true });

/** SQLite, in one file under DATA_DIR. */
const database = openDatabase(
  `file:${path.join(databaseDirectory, "parley.db")}`,
);

export const db = database.db;

/**
 * A query runner that is either `db` or an open transaction. Write helpers
 * take one so several can be composed into a single atomic transaction; it
 * defaults to `db`, so a standalone call is unaffected.
 */
export type Executor =
  typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Sets the database up and brings its schema up to date. Runs at startup. */
export const migrateDb = database.migrate;

/** The last thing shutdown does. */
export const closeDb = database.close;

export * from "./schema";
