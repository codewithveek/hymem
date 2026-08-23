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
};

/**
 * MySQL is intentionally absent. It has no `ON CONFLICT`/`excluded`: upserts
 * are `ON DUPLICATE KEY UPDATE ... VALUES(col)` and ignores are `INSERT
 * IGNORE`, which is a different statement *shape*, not a different clause.
 * Adding it means letting the dialect build the whole INSERT rather than just
 * its tail — worth doing, but not worth faking with a string rewrite.
 */
