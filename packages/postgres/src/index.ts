/**
 * @hymem/postgres — Postgres storage for hymem.
 *
 *   import { createMemory } from "@hymem/core";
 *   import { postgres } from "@hymem/postgres";
 *
 *   const memory = createMemory({
 *     store: postgres({ client: pool }),
 *     model,
 *     namespace: `usr_${userId}`,
 *   });
 *
 * The store itself lives in `@hymem/core` and has no dependencies — only this driver
 * needs `pg`, which is why it is a separate package rather than an optional
 * peer dependency everyone would see warnings about.
 */
import { sqlStore, POSTGRES } from "@hymem/core/stores/sql";
import type { MemoryStore, SqlDriver, MigrateMode } from "@hymem/core/stores/sql";

/** Minimal shape of a `pg` Pool or Client — structural, so `pg` stays a peer dependency. */
export interface PgLike {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
  /**
   * A Pool checks out a connection and hands it back; a Client connects itself
   * and resolves to nothing. Both wear this method, which is why the driver
   * decides between them from what the call actually returns rather than from
   * the method's presence.
   *
   * It matters for transactions: issuing BEGIN through a *pool* is a bug,
   * because each statement may land on a different connection and the BEGIN
   * would apply to none of the work that follows. A Client is one connection,
   * so BEGIN on the client itself is exactly right.
   */
  connect?: () => Promise<PgClientLike | void>;
  end?: () => Promise<void>;
}

export interface PgClientLike {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
  /** Present on a pooled checkout, absent on a Client that owns its connection. */
  release?: () => void;
}

/**
 * node-postgres, and anything wearing its interface (pg.Pool, pg.Client,
 * Neon's serverless driver, Drizzle's postgres session).
 */
export function pgDriver(client: PgLike, options: { closeOnEnd?: boolean } = {}): SqlDriver {
  let ended = false;
  const driver: SqlDriver = {
    dialect: POSTGRES,
    async query<T>(sql: string, params: unknown[]): Promise<T[]> {
      const result = await client.query(sql, params);
      return result.rows as T[];
    },
    async close() {
      // pg throws "Called end on pool more than once" on the second end(), and
      // the store contract promises a second close is harmless.
      if (ended || options.closeOnEnd === false) return;
      ended = true;
      await client.end?.();
    },
  };

  if (!client.connect) return driver;

  /**
   * A Client owns a single connection, so its transactions cannot overlap: a
   * second BEGIN on the same connection fails outright. Serialising them costs
   * nothing, since the connection could only run them one at a time anyway.
   * A Pool needs no such queue — every transaction gets its own checkout.
   */
  let pending: Promise<unknown> = Promise.resolve();
  const serialised = <T>(run: () => Promise<T>): Promise<T> => {
    const result = pending.then(run, run);
    pending = result.catch(() => undefined);
    return result;
  };

  const pinnedDriver = (connection: PgLike | PgClientLike): SqlDriver => ({
    dialect: POSTGRES,
    async query<R>(sql: string, params: unknown[]): Promise<R[]> {
      const result = await connection.query(sql, params);
      return result.rows as R[];
    },
    async close() {},
  });

  const inTransaction = async <T>(
    connection: PgLike | PgClientLike,
    body: (tx: SqlDriver) => Promise<T>,
  ): Promise<T> => {
    await connection.query("BEGIN", []);
    try {
      const value = await body(pinnedDriver(connection));
      await connection.query("COMMIT", []);
      return value;
    } catch (error) {
      await connection.query("ROLLBACK", []).catch(() => undefined);
      throw error;
    }
  };

  /**
   * A checked-out pooled connection, or undefined when `client` turns out to be
   * a Client that connects itself and has nothing to hand back.
   */
  const checkOutConnection = async (): Promise<PgClientLike | undefined> => {
    try {
      const connected = (await client.connect!()) as PgClientLike | undefined;
      return connected && typeof connected.query === "function" ? connected : undefined;
    } catch (error) {
      // A pg.Client the caller already connected — the usual way one arrives
      // here — rejects a second connect() with exactly this. Every other
      // failure is the caller's to see.
      if (error instanceof Error && /already been connected/i.test(error.message)) return undefined;
      throw error;
    }
  };

  /** undefined until the first transaction has settled which kind of client this is. */
  let pooled: boolean | undefined;

  driver.transaction = async function transaction<T>(
    body: (tx: SqlDriver) => Promise<T>,
  ): Promise<T> {
    if (pooled !== false) {
      const checkout = await checkOutConnection();
      if (checkout) {
        pooled = true;
        try {
          return await inTransaction(checkout, body);
        } finally {
          checkout.release?.();
        }
      }
      pooled = false;
    }
    // `client` IS the connection. BEGIN belongs on it directly — and only one
    // transaction at a time can be in flight on a single connection.
    return serialised(() => inTransaction(client, body));
  };

  return driver;
}

export interface PostgresOptions {
  /**
   * A `pg` Pool or Client, or anything with the same query/end shape. A Pool is
   * the better default — one connection per statement, checked out only for the
   * duration — but a single Client works and gets serialised transactions.
   */
  client: PgLike;
  /** How the schema reaches the database. Default "check". */
  migrate?: MigrateMode;
  /** Table-name prefix, so hymem never collides with your own `facts` table. */
  tablePrefix?: string;
  /** Override the dialect's bind-parameter cap (unusual builds only). */
  maxParameters?: number;
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

export { POSTGRES } from "@hymem/core/stores/sql";
export type { SqlDriver, MigrateMode } from "@hymem/core/stores/sql";
