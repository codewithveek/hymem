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
  close(): Promise<void>;
}

/** Minimal shape of a `pg` Pool or Client — structural, so `pg` stays a peer dependency. */
export interface PgLike {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
  end?: () => Promise<void>;
}

/**
 * node-postgres, and anything wearing its interface (pg.Pool, pg.Client,
 * Neon's serverless driver, Drizzle's postgres session).
 */
export function pgDriver(client: PgLike, options: { closeOnEnd?: boolean } = {}): SqlDriver {
  return {
    dialect: POSTGRES,
    async query<T>(sql: string, params: unknown[]): Promise<T[]> {
      const result = await client.query(sql, params);
      return result.rows as T[];
    },
    async close() {
      if (options.closeOnEnd !== false) await client.end?.();
    },
  };
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
  const RETURNS_ROWS = /^\s*(SELECT|PRAGMA|WITH)\b/i;
  return {
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
}
