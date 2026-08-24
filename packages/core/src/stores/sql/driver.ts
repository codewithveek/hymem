/**
 * The SQL driver seam — two methods.
 *
 * This is the leverage in the whole adapter story: `sqlStore` is written once
 * against this interface, and pg / better-sqlite3 / libSQL / D1 / Drizzle /
 * Prisma each become a binding of roughly fifteen lines rather than an adapter
 * of three hundred. Anything that can run a parameterised statement and hand
 * back rows qualifies, which is why "works with your ORM" is a real claim and
 * not a rewrite per ORM.
 *
 * The interface lives here, in the dependency-free core. The implementations
 * live in the packages that carry the corresponding peer dependency —
 * `@hymem/postgres` needs `pg`, `@hymem/sqlite` does not need anything — so no
 * user installs a driver they will never call.
 */
import type { SqlDialect } from "./dialect.js";

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
