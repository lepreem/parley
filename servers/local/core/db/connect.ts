import {
  createClient,
  type Client,
  type Transaction,
  type TransactionMode,
} from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "./schema";

/**
 * Hands out turns one at a time, in the order they were asked for. A turn is
 * held until its `release` is called.
 */
function createQueue() {
  let tail: Promise<void> = Promise.resolve();

  return function takeTurn(): Promise<() => void> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => (release = resolve));
    const ready = tail.then(() => release);
    tail = tail.then(() => turn);
    return ready;
  };
}

/** A method of `target`, still bound to it: libSQL's classes use private fields. */
function boundMember(target: object, property: string | symbol) {
  const value: unknown = Reflect.get(target, property);
  return typeof value === "function" ? value.bind(target) : value;
}

/**
 * The client, with every statement and transaction run one at a time.
 *
 * SQLite runs synchronously under libSQL, so a write that finds another
 * connection holding the write lock doesn't wait for it: it blocks the event
 * loop, which stops that transaction from ever finishing, until the busy
 * timeout fails the write. Taking turns here instead means nothing reaches
 * SQLite while a transaction is open. A transaction holds its turn until it
 * commits or rolls back.
 *
 * So work inside a transaction must go through its own handle: a query on `db`
 * there waits for the transaction's turn to end, which it never does.
 */
function oneAtATime(client: Client): Client {
  const takeTurn = createQueue();

  async function inTurn<T>(work: () => Promise<T>): Promise<T> {
    const release = await takeTurn();
    try {
      return await work();
    } finally {
      release();
    }
  }

  async function transaction(mode?: TransactionMode): Promise<Transaction> {
    const release = await takeTurn();
    let transaction: Transaction;
    try {
      transaction = await client.transaction(mode);
    } catch (error) {
      release();
      throw error;
    }

    const ending = new Set<string | symbol>(["commit", "rollback", "close"]);
    return new Proxy(transaction, {
      get(target, property) {
        const member = boundMember(target, property);
        if (!ending.has(property) || typeof member !== "function")
          return member;
        return async (...args: unknown[]) => {
          try {
            return await member(...args);
          } finally {
            release();
          }
        };
      },
    });
  }

  const inTurnMethods = new Set<string | symbol>([
    "execute",
    "batch",
    "migrate",
    "executeMultiple",
    "close",
  ]);
  return new Proxy(client, {
    get(target, property) {
      if (property === "transaction") return transaction;
      const member = boundMember(target, property);
      if (!inTurnMethods.has(property) || typeof member !== "function")
        return member;
      return (...args: unknown[]) => inTurn(async () => member(...args));
    },
  });
}

/**
 * Relative to the working directory, which is the package root in development
 * and /app in the image.
 */
const MIGRATIONS_FOLDER = "./drizzle";

/**
 * Opens the SQLite database at `url`, a file: URL or ":memory:". Free of side
 * effects until called, so tests can open their own.
 */
export function openDatabase(url: string) {
  const client = oneAtATime(createClient({ url, concurrency: 1 }));
  const db = drizzle({ client, schema });

  return {
    db,

    /**
     * Sets the database up and brings its schema up to date. Runs before
     * anything queries.
     */
    async migrate() {
      // Write-ahead logging: a crash can't leave a half-written page, and it's
      // stored in the file, so it holds for every later connection. Foreign
      // keys need nothing: libSQL turns them on for every connection.
      await db.run(sql`pragma journal_mode = wal`);
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    },

    /** Closes the database once queued work is done. */
    async close() {
      // close() takes its turn like any statement, so this waits for the queue.
      await client.close();
    },
  };
}
