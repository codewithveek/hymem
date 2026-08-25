/**
 * @hymem/postgres — Postgres storage for hymem.
 *
 *   import { createMemory } from "hymem";
 *   import { postgres } from "@hymem/postgres";
 *
 *   const memory = createMemory({
 *     store: postgres({ client: pool }),
 *     model,
 *     namespace: `usr_${userId}`,
 *   });
 *
 * The store itself lives in `hymem` and has no dependencies — only this driver
 * needs `pg`, which is why it is a separate package rather than an optional
 * peer dependency everyone would see warnings about.
 */
import { sqlStore, POSTGRES } from "hymem/stores/sql";
import type { MemoryStore, SqlDriver, MigrateMode } from "hymem/stores/sql";

/** Minimal shape of a `pg` Pool or Client — structural, so `pg` stays a peer dependency. */
export interface PgLike {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
  /**
   * Present on a Pool. Required for transactions: issuing BEGIN through the
   * pool itself is a bug, because each statement may land on a DIFFERENT
   * connection and the BEGIN would apply to none of the work that follows.
   */
  connect?: () => Promise<PgClientLike>;
  end?: () => Promise<void>;
}

export interface PgClientLike {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
  release: () => void;
}

/**
 * node-postgres, and anything wearing its interface (pg.Pool, pg.Client,
 * Neon's serverless driver, Drizzle's postgres session).
 */
export function pgDriver(client: PgLike, options: { closeOnEnd?: boolean } = {}): SqlDriver {
  const driver: SqlDriver = {
    dialect: POSTGRES,
    async query<T>(sql: string, params: unknown[]): Promise<T[]> {
      const result = await client.query(sql, params);
      return result.rows as T[];
    },
    async close() {
      if (options.closeOnEnd !== false) await client.end?.();
    },
  };

  if (client.connect) {
    driver.transaction = async function transaction<T>(
      body: (tx: SqlDriver) => Promise<T>,
    ): Promise<T> {
      const connection = await client.connect!();
      const pinned: SqlDriver = {
        dialect: POSTGRES,
        async query<R>(sql: string, params: unknown[]): Promise<R[]> {
          const result = await connection.query(sql, params);
          return result.rows as R[];
        },
        async close() {},
      };
      try {
        await connection.query("BEGIN", []);
        const value = await body(pinned);
        await connection.query("COMMIT", []);
        return value;
      } catch (error) {
        await connection.query("ROLLBACK", []).catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    };
  }
  return driver;
}

export interface PostgresOptions {
  /** A `pg` Pool or Client, or anything with the same query/end shape. */
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

export { POSTGRES } from "hymem/stores/sql";
export type { SqlDriver, MigrateMode } from "hymem/stores/sql";
