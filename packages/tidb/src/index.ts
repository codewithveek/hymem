/**
 * @hymem/tidb — TiDB storage for hymem.
 *
 *   import { createMemory } from "@hymem/core";
 *   import { tidb } from "@hymem/tidb";
 *   import { connect } from "@tidbcloud/serverless";
 *
 *   const memory = createMemory({
 *     store: tidb({ connection: connect({ url: process.env.DATABASE_URL }) }),
 *     model,
 *     namespace: `usr_${userId}`,
 *   });
 *
 * TiDB speaks the MySQL protocol, which differs from Postgres and SQLite in
 * ways the dialect has to know about: no RETURNING at all, no data-modifying
 * CTEs, `ON DUPLICATE KEY UPDATE` instead of `ON CONFLICT`, and `INSERT IGNORE`
 * as a statement prefix rather than a trailing clause.
 *
 * Two drivers ship here because TiDB is reachable two ways. The serverless
 * driver speaks HTTP and runs on edge runtimes; mysql2 speaks the wire protocol
 * and suits a long-lived Node process or a self-hosted cluster.
 */
import { sqlStore, TIDB } from "@hymem/core/stores/sql";
import type { MemoryStore, SqlDriver, MigrateMode } from "@hymem/core/stores/sql";

// --- @tidbcloud/serverless ---------------------------------------------------

/** Minimal shape of a `@tidbcloud/serverless` connection. */
export interface TidbServerlessConnection {
  execute(sql: string, params?: unknown[], options?: unknown): Promise<unknown>;
  begin?: () => Promise<TidbServerlessTransaction>;
}

export interface TidbServerlessTransaction {
  execute(sql: string, params?: unknown[], options?: unknown): Promise<unknown>;
  commit(): Promise<unknown>;
  rollback(): Promise<unknown>;
}

/**
 * The serverless driver returns rows directly for a SELECT and a result-info
 * object for a write, so anything that is not an array becomes an empty set.
 */
const asRows = <T>(result: unknown): T[] => (Array.isArray(result) ? (result as T[]) : []);

/**
 * TiDB Cloud over HTTP. Works in Workers, Vercel Edge, and any fetch runtime.
 *
 * Interactive transactions are supported through `begin()`, so supersession
 * commits as one unit and `atomicSupersede` is true. TiDB rolls back a
 * transaction left idle for ten minutes.
 */
export function tidbServerlessDriver(connection: TidbServerlessConnection): SqlDriver {
  const driver: SqlDriver = {
    dialect: TIDB,
    async query<T>(sql: string, params: unknown[]): Promise<T[]> {
      return asRows<T>(await connection.execute(sql, params, { arrayMode: false }));
    },
    async close() {
      // Stateless over HTTP — there is no connection to release.
    },
  };

  if (connection.begin) {
    driver.transaction = async function transaction<T>(
      body: (tx: SqlDriver) => Promise<T>,
    ): Promise<T> {
      const tx = await connection.begin!();
      const scoped: SqlDriver = {
        dialect: TIDB,
        async query<R>(sql: string, params: unknown[]): Promise<R[]> {
          return asRows<R>(await tx.execute(sql, params, { arrayMode: false }));
        },
        async close() {},
      };
      try {
        const value = await body(scoped);
        await tx.commit();
        return value;
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        throw error;
      }
    };
  }
  return driver;
}

// --- mysql2 ------------------------------------------------------------------

/** Minimal shape of a `mysql2/promise` pool or connection. */
export interface MysqlLike {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  getConnection?: () => Promise<MysqlConnectionLike>;
  end?: () => Promise<void>;
}

export interface MysqlConnectionLike {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

/**
 * mysql2 over the wire protocol — a self-hosted TiDB cluster, or MySQL 8.
 *
 * As with Postgres, transactions need a pinned connection: issuing
 * BEGIN through a pool applies it to whichever connection happened to serve
 * that one statement, not to the work that follows. Without `getConnection`
 * the driver omits `transaction` and the store reports `atomicSupersede:
 * false` rather than pretending.
 */
export function mysqlDriver(client: MysqlLike, options: { closeOnEnd?: boolean } = {}): SqlDriver {
  const driver: SqlDriver = {
    dialect: TIDB,
    async query<T>(sql: string, params: unknown[]): Promise<T[]> {
      const [rows] = await client.query(sql, params);
      return asRows<T>(rows);
    },
    async close() {
      if (options.closeOnEnd !== false) await client.end?.();
    },
  };

  if (client.getConnection) {
    driver.transaction = async function transaction<T>(
      body: (tx: SqlDriver) => Promise<T>,
    ): Promise<T> {
      const connection = await client.getConnection!();
      const scoped: SqlDriver = {
        dialect: TIDB,
        async query<R>(sql: string, params: unknown[]): Promise<R[]> {
          const [rows] = await connection.query(sql, params);
          return asRows<R>(rows);
        },
        async close() {},
      };
      try {
        await connection.beginTransaction();
        const value = await body(scoped);
        await connection.commit();
        return value;
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    };
  }
  return driver;
}

// --- factories ---------------------------------------------------------------

export interface TidbOptions {
  /** A `@tidbcloud/serverless` connection (HTTP, edge-compatible). */
  connection?: TidbServerlessConnection;
  /** A `mysql2/promise` pool or connection (wire protocol). */
  client?: MysqlLike;
  /** How the schema reaches the database. Default "check". */
  migrate?: MigrateMode;
  /** Table-name prefix, so hymem never collides with your own tables. */
  tablePrefix?: string;
  /** Override the dialect's bind-parameter cap. */
  maxParameters?: number;
  /** Close the underlying mysql2 client when the store closes. Default true. */
  closeOnEnd?: boolean;
}

export function tidb(options: TidbOptions): MemoryStore {
  const driver = options.connection
    ? tidbServerlessDriver(options.connection)
    : options.client
      ? mysqlDriver(options.client, { closeOnEnd: options.closeOnEnd })
      : undefined;
  if (!driver) {
    throw new Error(
      "@hymem/tidb: pass either `connection` (a @tidbcloud/serverless connection) " +
        "or `client` (a mysql2/promise pool).",
    );
  }
  return sqlStore({
    driver,
    migrate: options.migrate,
    tablePrefix: options.tablePrefix,
    maxParameters: options.maxParameters,
  });
}

/** MySQL 8 over mysql2. TiDB's dialect is MySQL's, so this is the same store. */
export const mysql = (options: Omit<TidbOptions, "connection"> & { client: MysqlLike }): MemoryStore =>
  tidb(options);

export { TIDB, MYSQL } from "@hymem/core/stores/sql";
export type { SqlDriver, MigrateMode } from "@hymem/core/stores/sql";
