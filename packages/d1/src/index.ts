/**
 * @hymem/d1 — Cloudflare D1 storage for hymem.
 *
 *   import { createMemory } from "@hymem/core";
 *   import { d1 } from "@hymem/d1";
 *
 *   export default {
 *     async fetch(request, env) {
 *       const memory = createMemory({
 *         store: d1({ database: env.DB }),
 *         model,
 *         namespace: `usr_${userId}`,
 *       });
 *       ...
 *     },
 *   };
 *
 * D1 is SQLite, so the SQL is the SQLite dialect unchanged. Two platform
 * limits shape the adapter:
 *
 *   - **100 bind parameters per statement**, roughly 300x tighter than SQLite's
 *     own cap. Every list-valued predicate in the store chunks below the
 *     dialect's `maxParameters`, which is why this works at all.
 *   - **No interactive transactions.** D1 offers `batch()` — an atomic array of
 *     prepared statements — but a Worker cannot hold a transaction open across
 *     round trips, because the SQL runs in the database while the JS runs at
 *     the edge, and one open write transaction would block the whole database.
 *
 * Supersession needs to read which facts it is closing before it closes them,
 * so it cannot be expressed as a fixed batch. The driver therefore omits
 * `transaction` and the store reports `atomicSupersede: false`. Single-writer
 * ingest is correct; two Workers racing for the same (subject, attribute) slot
 * can both see it unclaimed.
 */
import { sqlStore, D1 as D1_DIALECT } from "@hymem/core/stores/sql";
import type { MemoryStore, SqlDriver, MigrateMode } from "@hymem/core/stores/sql";

/** Minimal shape of a D1 prepared statement. */
export interface D1PreparedStatementLike {
  bind(...params: unknown[]): D1PreparedStatementLike;
  all<T = unknown>(): Promise<{ results?: T[] }>;
}

/** Minimal shape of the `D1Database` binding — structural, so no peer dependency. */
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch?<T = unknown>(statements: D1PreparedStatementLike[]): Promise<{ results?: T[] }[]>;
}

export function d1Driver(database: D1DatabaseLike): SqlDriver {
  return {
    dialect: D1_DIALECT,
    async query<T>(sql: string, params: unknown[]): Promise<T[]> {
      // `all()` is correct for writes too: D1 returns an empty result set
      // rather than erroring, and it keeps one code path for both.
      const statement = params.length
        ? database.prepare(sql).bind(...params)
        : database.prepare(sql);
      const result = await statement.all<T>();
      return result.results ?? [];
    },
    async close() {
      // The binding is owned by the Worker runtime; there is nothing to release.
    },
  };
}

export interface D1Options {
  /** The `D1Database` binding from your Worker's `env`. */
  database: D1DatabaseLike;
  /**
   * How the schema reaches the database. Default "check".
   *
   * Prefer applying migrations with `wrangler d1 migrations apply` and leaving
   * this at "check" — a Worker runs on every request, so "auto" would attempt
   * schema work in the hot path.
   */
  migrate?: MigrateMode;
  /** Table-name prefix, so hymem never collides with your own tables. */
  tablePrefix?: string;
  /** Override the 100-parameter cap. Lowering it is safe; raising it is not. */
  maxParameters?: number;
}

export function d1(options: D1Options): MemoryStore {
  return sqlStore({
    driver: d1Driver(options.database),
    migrate: options.migrate,
    tablePrefix: options.tablePrefix,
    maxParameters: options.maxParameters,
  });
}

export { D1 } from "@hymem/core/stores/sql";
export type { SqlDriver, MigrateMode } from "@hymem/core/stores/sql";
