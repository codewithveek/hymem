/**
 * SQL store internals.
 *
 * Dependency-free: the store, the dialects, the schema, and the driver
 * interface. Concrete drivers live in the packages that carry their peer
 * dependency — `@hymem/postgres` (pg) and `@hymem/sqlite` (node:sqlite).
 */
export { sqlStore } from "./store.js";
export type { SqlStoreOptions } from "./store.js";
export { POSTGRES, SQLITE } from "./dialect.js";
export type { SqlDialect } from "./dialect.js";
export type { SqlDriver } from "./driver.js";
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
export type { MemoryStore } from "../../core/ports.js";
