/**
 * SQL store internals.
 *
 * Dependency-free: the store, the dialects, the schema, and the driver
 * interface. Concrete drivers live in the packages that carry their peer
 * dependency — `@hymem/postgres` (pg) and `@hymem/sqlite` (node:sqlite).
 */
import { sqlStore as makeSqlStore } from "./store.js";
import type { SqlDriver as Driver } from "./driver.js";
import type { MemoryStore as Store } from "../../core/ports.js";
import type { MigrateMode as Migrate } from "./schema.js";

export { sqlStore } from "./store.js";
export type { SqlStoreOptions } from "./store.js";

/**
 * Bring your own driver — any ORM or client that can run parameterised SQL.
 *
 * This is the seam that makes "works with your ORM" a real claim: Drizzle,
 * Prisma, libSQL, D1 and the rest are a binding of a few lines, not an adapter.
 */
export function sql(
  driver: Driver,
  options: { migrate?: Migrate; tablePrefix?: string; maxParameters?: number } = {},
): Store {
  return makeSqlStore({ driver, ...options });
}
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
