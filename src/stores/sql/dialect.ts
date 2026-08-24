/**
 * What differs between SQL engines.
 *
 * One SqlMemoryStore serves Postgres, SQLite, MySQL and anything else that
 * speaks a close-enough dialect; the differences are confined here, the same
 * way the Cypher store confines HydraDB's quirks to a Dialect.
 */
export interface SqlDialect {
  name: string;
  /** Bind-parameter marker for the nth (1-based) parameter: `$1` or `?`. */
  placeholder(position: number): string;
  /**
   * Conflict clause for an idempotent insert that refreshes existing rows.
   * Postgres and SQLite share `ON CONFLICT ... DO UPDATE`; MySQL differs.
   */
  upsert(conflictColumns: string[], assignments: string[]): string;
  /** Conflict clause for an insert that should silently skip duplicates. */
  insertIgnore(conflictColumns: string[]): string;
  /** Column type for the session ordinal. */
  integerType: string;
  /** Column type for ids and short keys. MySQL cannot index unbounded TEXT. */
  keyType: string;
  /** Column type for free text. */
  textType: string;
  /**
   * `UPDATE ... RETURNING` may appear inside a CTE that an INSERT then reads,
   * so supersession is one atomic statement. Postgres has this; SQLite's CTEs
   * cannot contain UPDATE, so it needs an explicit transaction instead.
   */
  dataModifyingCte: boolean;
  /** `UPDATE`/`DELETE ... RETURNING` is supported (Postgres; SQLite >= 3.35). */
  returning: boolean;
  /**
   * Hard cap on bind parameters in one statement. Exceeding it is a driver
   * error, not a slow query, so any list-valued predicate must be chunked
   * below this.
   *
   * Postgres allows 65535. SQLite's cap is the compile-time
   * SQLITE_MAX_VARIABLE_NUMBER, which has defaulted to 32766 since 3.32 (2020)
   * and is 32766 in Node 22's bundled build — verified, not assumed. Builds
   * older than that use 999; override `maxParameters` on the store if you are
   * on one. Setting it too low only costs extra round trips, so it fails safe.
   */
  maxParameters: number;
}

/** Postgres and SQLite differ only in placeholder style. */
const onConflictUpsert = (conflictColumns: string[], assignments: string[]) =>
  `ON CONFLICT (${conflictColumns.join(", ")}) DO UPDATE SET ${assignments.join(", ")}`;

const onConflictIgnore = (conflictColumns: string[]) =>
  `ON CONFLICT (${conflictColumns.join(", ")}) DO NOTHING`;

export const POSTGRES: SqlDialect = {
  name: "postgres",
  placeholder: (position) => `$${position}`,
  upsert: onConflictUpsert,
  insertIgnore: onConflictIgnore,
  integerType: "INTEGER",
  keyType: "TEXT",
  textType: "TEXT",
  dataModifyingCte: true,
  returning: true,
  maxParameters: 65535,
};

export const SQLITE: SqlDialect = {
  name: "sqlite",
  placeholder: () => "?",
  upsert: onConflictUpsert,
  insertIgnore: onConflictIgnore,
  integerType: "INTEGER",
  keyType: "TEXT",
  textType: "TEXT",
  dataModifyingCte: false,
  returning: true, // SQLite >= 3.35, which is well below Node 22's bundled build
  maxParameters: 32766,
};

/**
 * MySQL is intentionally absent. It has no `ON CONFLICT`/`excluded`: upserts
 * are `ON DUPLICATE KEY UPDATE ... VALUES(col)` and ignores are `INSERT
 * IGNORE`, which is a different statement *shape*, not a different clause.
 * Adding it means letting the dialect build the whole INSERT rather than just
 * its tail — worth doing, but not worth faking with a string rewrite.
 */
