/**
 * What differs between SQL engines.
 *
 * One `sqlStore` serves Postgres, SQLite, MySQL/TiDB, Cloudflare D1 and
 * anything close enough; the differences are confined here, the same way the
 * Cypher store confines HydraDB's quirks to a Dialect.
 *
 * The dialect owns whole *statement shapes*, not just clause tails, because
 * MySQL forced the issue: an upsert there is `ON DUPLICATE KEY UPDATE col =
 * VALUES(col)` rather than `ON CONFLICT (...) DO UPDATE SET col =
 * excluded.col`, and skipping duplicates is `INSERT IGNORE INTO` — a statement
 * *prefix*, not a suffix. A dialect that could only append text could not
 * express that.
 */

/**
 * One column of an upsert's refresh list.
 *
 * `literal` writes a fixed SQL expression instead of the incoming value —
 * that is how a re-stated fact is forced back to `status = 'active'` and
 * `valid_to = NULL` regardless of what was inserted.
 */
export interface UpsertColumn {
  column: string;
  literal?: string;
}

/** How an INSERT is written, split so a dialect can change the verb itself. */
export interface InsertShape {
  /** Statement opener — "INSERT INTO" or MySQL's "INSERT IGNORE INTO". */
  prefix: string;
  /** Trailing conflict clause, or "" when the prefix already said it. */
  tail: string;
}

export interface SqlDialect {
  name: string;
  /** Bind-parameter marker for the nth (1-based) parameter: `$1` or `?`. */
  placeholder(position: number): string;
  /** Insert that refreshes the named columns when the row already exists. */
  upsert(conflictColumns: string[], updates: UpsertColumn[]): InsertShape;
  /** Insert that silently skips rows that already exist. */
  insertIgnore(conflictColumns: string[]): InsertShape;
  /** Column type for the session ordinal. */
  integerType: string;
  /** Column type for ids and short keys. MySQL cannot index unbounded TEXT. */
  keyType: string;
  /** Column type for free text. */
  textType: string;
  /**
   * `UPDATE ... RETURNING` may appear inside a CTE that an INSERT then reads,
   * so supersession is one atomic statement. Postgres has this; SQLite's CTEs
   * cannot contain UPDATE, and MySQL has neither.
   */
  dataModifyingCte: boolean;
  /**
   * `UPDATE`/`DELETE ... RETURNING` is supported (Postgres; SQLite >= 3.35).
   * MySQL and TiDB have no RETURNING at all, so supersession there must read
   * the doomed ids with a SELECT first and lean on a transaction for atomicity.
   */
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
   * on one. D1 allows only 100. Setting it too low costs extra round trips,
   * so it fails safe.
   */
  maxParameters: number;
}

// --- Postgres and SQLite: ON CONFLICT, with `excluded` for incoming values ---

const onConflictUpsert = (conflictColumns: string[], updates: UpsertColumn[]): InsertShape => ({
  prefix: "INSERT INTO",
  tail:
    `ON CONFLICT (${conflictColumns.join(", ")}) DO UPDATE SET ` +
    updates
      .map(({ column, literal }) => `${column} = ${literal ?? `excluded.${column}`}`)
      .join(", "),
});

const onConflictIgnore = (conflictColumns: string[]): InsertShape => ({
  prefix: "INSERT INTO",
  tail: `ON CONFLICT (${conflictColumns.join(", ")}) DO NOTHING`,
});

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
  returning: true, // SQLite >= 3.35, well below Node 22's bundled build
  maxParameters: 32766,
};

/**
 * Cloudflare D1 is SQLite, with two differences that matter.
 *
 * Only 100 bind parameters per statement — 300x tighter than SQLite's own cap,
 * which is why list predicates must chunk rather than assume.
 *
 * And no interactive transactions: D1 offers `batch()`, an atomic array of
 * prepared statements, but a Worker cannot hold a transaction open across
 * round trips. The driver therefore omits `transaction`, and the store reports
 * `atomicSupersede: false` rather than pretending.
 */
export const D1: SqlDialect = {
  ...SQLITE,
  name: "d1",
  maxParameters: 100,
};

// --- MySQL and TiDB: ON DUPLICATE KEY, with VALUES() for incoming values ---

export const MYSQL: SqlDialect = {
  name: "mysql",
  placeholder: () => "?",
  // The conflict target is implied by the table's unique keys — MySQL has no
  // way to name it, so `conflictColumns` is accepted and ignored.
  upsert: (_conflictColumns, updates) => ({
    prefix: "INSERT INTO",
    tail:
      "ON DUPLICATE KEY UPDATE " +
      updates
        .map(({ column, literal }) => `${column} = ${literal ?? `VALUES(${column})`}`)
        .join(", "),
  }),
  // A different statement, not a different clause.
  insertIgnore: () => ({ prefix: "INSERT IGNORE INTO", tail: "" }),
  integerType: "INT",
  // MySQL cannot index unbounded TEXT, and these columns are all indexed or
  // part of a primary key. 191 keeps a composite key inside InnoDB's 3072-byte
  // limit under utf8mb4.
  keyType: "VARCHAR(191)",
  textType: "TEXT",
  dataModifyingCte: false,
  returning: false,
  maxParameters: 65535,
};

/** TiDB speaks the MySQL protocol and shares its dialect exactly. */
export const TIDB: SqlDialect = { ...MYSQL, name: "tidb" };
