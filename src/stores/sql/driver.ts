/**
 * The SQL driver seam — two methods.
 *
 * This is the leverage in the whole adapter story: `SqlMemoryStore` is written
 * once, and pg / better-sqlite3 / libSQL / D1 / Drizzle / Prisma each become a
 * binding of roughly fifteen lines rather than an adapter of three hundred.
 * Anything that can run a parameterised statement and hand back rows qualifies,
 * which is why "works with your ORM" is a real claim and not a rewrite per ORM.
 */
import type { SqlDialect } from "./dialect.js";
import { POSTGRES, SQLITE } from "./dialect.js";

export interface SqlDriver {
  readonly dialect: SqlDialect;
  query<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]>;
  /**
   * Run `body` against a single connection inside BEGIN/COMMIT, rolling back on
   * throw. Optional: a driver that cannot pin a connection simply omits it, and
   * the store falls back to unwrapped statements and reports
   * `atomicSupersede: false` rather than pretending.
   */
  transaction?<T>(body: (tx: SqlDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Minimal shape of a `pg` Pool or Client — structural, so `pg` stays a peer dependency. */
export interface PgLike {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
  /**
   * Present on a Pool. Required for transactions: issuing BEGIN through the
   * pool itself is a bug, because each statement may land on a DIFFERENT
   * connection and the BEGIN would apply to none of the work that follows.
   */
  connect?: () => Promise<PgClientLike>;
  end?: () => Promise<void>;
}

export interface PgClientLike {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
  release: () => void;
}

/**
 * node-postgres, and anything wearing its interface (pg.Pool, pg.Client,
 * Neon's serverless driver, Drizzle's postgres session).
 */
export function pgDriver(client: PgLike, options: { closeOnEnd?: boolean } = {}): SqlDriver {
  const driver: SqlDriver = {
    dialect: POSTGRES,
    async query<T>(sql: string, params: unknown[]): Promise<T[]> {
      const result = await client.query(sql, params);
      return result.rows as T[];
    },
    async close() {
      if (options.closeOnEnd !== false) await client.end?.();
    },
  };

  if (client.connect) {
    driver.transaction = async function transaction<T>(
      body: (tx: SqlDriver) => Promise<T>,
    ): Promise<T> {
      const connection = await client.connect!();
      const pinned: SqlDriver = {
        dialect: POSTGRES,
        async query<R>(sql: string, params: unknown[]): Promise<R[]> {
          const result = await connection.query(sql, params);
          return result.rows as R[];
        },
        async close() {},
      };
      try {
        await connection.query("BEGIN", []);
        const value = await body(pinned);
        await connection.query("COMMIT", []);
        return value;
      } catch (error) {
        await connection.query("ROLLBACK", []).catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    };
  }
  return driver;
}

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

/**
 * node:sqlite (built into Node 22.5+) and better-sqlite3, which share the
 * prepare/all/run shape.
 *
 * SQLite is synchronous: statements that return no rows must be `run`, not
 * `all`, so the driver dispatches on the leading keyword.
 */
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
