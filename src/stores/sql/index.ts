/**
 * SQL store factories.
 *
 *   import { postgres } from "hymem/stores/sql";
 *   const memory = createMemory({ store: postgres({ client: pool }), model });
 *
 * When the packages are split these become @hymem/postgres, @hymem/sqlite and
 * so on: separate packages so each declares only the peer dependency it needs
 * (`pg`, `better-sqlite3`, ...) instead of one package optional-peer-depending
 * on every driver and warning users about the three they don't use.
 */
import type { MemoryStore } from "../../core/ports.js";
import { sqlStore, type SqlStoreOptions } from "./store.js";
import { pgDriver, sqliteDriver, type PgLike, type SqliteLike, type SqlDriver } from "./driver.js";
import type { MigrateMode } from "./schema.js";

export interface SqlConnectOptions {
  migrate?: MigrateMode;
  tablePrefix?: string;
  /** Override the dialect's bind-parameter cap (unusual builds only). */
  maxParameters?: number;
}

export interface PostgresOptions extends SqlConnectOptions {
  /** A `pg` Pool or Client, or anything with the same query/end shape. */
  client: PgLike;
  /** Close the underlying client when the store closes. Default true. */
  closeOnEnd?: boolean;
}

export function postgres(options: PostgresOptions): MemoryStore {
  return sqlStore({
    driver: pgDriver(options.client, { closeOnEnd: options.closeOnEnd }),
    migrate: options.migrate,
    tablePrefix: options.tablePrefix,
    maxParameters: options.maxParameters,
  });
}

export interface SqliteOptions extends SqlConnectOptions {
  /** A node:sqlite DatabaseSync or a better-sqlite3 Database. */
  database: SqliteLike;
}

export function sqlite(options: SqliteOptions): MemoryStore {
  return sqlStore({
    driver: sqliteDriver(options.database),
    migrate: options.migrate,
    tablePrefix: options.tablePrefix,
    maxParameters: options.maxParameters,
  });
}

/** Bring your own driver — any ORM or client that can run parameterised SQL. */
export function sql(driver: SqlDriver, options: SqlConnectOptions = {}): MemoryStore {
  return sqlStore({ driver, ...options });
}

export { sqlStore, pgDriver, sqliteDriver };
export { POSTGRES, SQLITE, type SqlDialect } from "./dialect.js";
export {
  schemaScript,
  tableNames,
  createTableStatements,
  assertSafeTablePrefix,
  MissingSchemaError,
  UnsafeTablePrefixError,
  type MigrateMode,
  type TableNames,
} from "./schema.js";
export type { SqlDriver, PgLike, SqliteLike, SqlStoreOptions };
