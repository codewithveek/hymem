/**
 * @hymem/sqlite — SQLite storage for hymem.
 *
 *   import { createMemory } from "@hymem/core";
 *   import { sqlite } from "@hymem/sqlite";
 *   import { DatabaseSync } from "node:sqlite";
 *
 *   const memory = createMemory({
 *     store: sqlite({ database: new DatabaseSync("memory.db") }),
 *     model,
 *     namespace: "local",
 *   });
 *
 * No peer dependency at all: `node:sqlite` is built into Node 22.5+.
 * better-sqlite3 works too — it wears the same prepare/all/run shape.
 */
import { sqlStore, SQLITE } from "@hymem/core/stores/sql";
import type { MemoryStore, SqlDriver, MigrateMode } from "@hymem/core/stores/sql";

/**
 * Minimal shape of a synchronous SQLite handle (node:sqlite, better-sqlite3).
 *
 * Parameters are typed `any` deliberately: node:sqlite declares them as its own
 * `SQLInputValue` union, and a narrower parameter type is not assignable to a
 * wider one, so `unknown[]` here would reject `DatabaseSync` outright. `any` in
 * an input position is what lets one structural interface accept every client.
 */
export interface SqliteLike {
  prepare(sql: string): {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    all: (...params: any[]) => unknown[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run: (...params: any[]) => unknown;
  };
  close?: () => void;
}

export function sqliteDriver(database: SqliteLike): SqlDriver {
  // `RETURNING` makes an UPDATE/DELETE/INSERT produce rows too, so dispatch on
  // that as well as on the leading keyword.
  const RETURNS_ROWS = /^\s*(SELECT|PRAGMA|WITH)\b|\bRETURNING\b/i;
  const driver: SqlDriver = {
    dialect: SQLITE,
    async query<T>(sql: string, params: unknown[]): Promise<T[]> {
      const statement = database.prepare(sql);
      if (!RETURNS_ROWS.test(sql)) {
        statement.run(...params);
        return [];
      }
      return statement.all(...params) as T[];
    },
    async close() {
      database.close?.();
    },
  };

  /**
   * SQLite holds ONE connection, so transactions cannot nest or overlap —
   * a second concurrent BEGIN fails with "cannot start a transaction within a
   * transaction". Serialising them is both correct and free: SQLite serialises
   * writes anyway, so the queue only makes explicit what the engine already does.
   */
  let pending: Promise<unknown> = Promise.resolve();

  driver.transaction = function transaction<T>(body: (tx: SqlDriver) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await driver.query("BEGIN", []);
      try {
        const value = await body(driver);
        await driver.query("COMMIT", []);
        return value;
      } catch (error) {
        await driver.query("ROLLBACK", []).catch(() => undefined);
        throw error;
      }
    };
    // Chain on both settle paths so one failed transaction cannot wedge the queue.
    const result = pending.then(run, run);
    pending = result.catch(() => undefined);
    return result;
  };
  return driver;
}

export interface SqliteOptions {
  /** A node:sqlite DatabaseSync or a better-sqlite3 Database. */
  database: SqliteLike;
  /** How the schema reaches the database. Default "check". */
  migrate?: MigrateMode;
  /** Table-name prefix, so hymem never collides with your own `facts` table. */
  tablePrefix?: string;
  /** Override the dialect's bind-parameter cap (unusual builds only). */
  maxParameters?: number;
}

export function sqlite(options: SqliteOptions): MemoryStore {
  return sqlStore({
    driver: sqliteDriver(options.database),
    migrate: options.migrate,
    tablePrefix: options.tablePrefix,
    maxParameters: options.maxParameters,
  });
}

export { SQLITE } from "@hymem/core/stores/sql";
export type { SqlDriver, MigrateMode } from "@hymem/core/stores/sql";
