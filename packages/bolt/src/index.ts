/**
 * @hymem/bolt — graph storage for hymem over the Bolt protocol.
 *
 *   import { createMemory } from "@hymem/core";
 *   import { hydradb } from "@hymem/bolt";
 *
 *   const memory = createMemory({
 *     store: hydradb({ url: "bolt://127.0.0.1:7687", token: process.env.HYDRA_TOKEN }),
 *     model,
 *     namespace: "org_42",
 *   });
 *
 * One package rather than @hymem/hydradb + @hymem/neo4j + @hymem/memgraph,
 * because all three speak Bolt and share the same single peer dependency. The
 * reason SQL is split per engine is that `pg` and `better-sqlite3` are
 * genuinely different installs; here there is nothing to separate.
 */
import neo4j, { type Driver } from "neo4j-driver";
import { cypherStore, HYDRADB, MEMGRAPH, NEO4J } from "@hymem/core/stores/cypher";
import type { CypherDriver, Dialect, MemoryStore } from "@hymem/core/stores/cypher";

export interface BoltOptions {
  url: string;
  token?: string;
  /** Basic auth as an alternative to bearer. */
  user?: string;
  password?: string;
  /**
   * Whether the server supports explicit write transactions.
   *
   * Neo4j and Memgraph do. HydraDB's Cypher subset does not, and issuing BEGIN
   * against it fails, so the factories below set this per engine rather than
   * probing at runtime.
   */
  transactions?: boolean;
}

/**
 * Bolt handshake flake (HydraDB <-> neo4j-driver-js >= 5.28): graph-node answers
 * the manifest-v1 handshake with several small TCP writes (HydraDB
 * src/client/bolt/wire.rs), and the JS driver's handshakeNegotiationV2 assumes
 * the whole manifest is in the first read. When the segments don't coalesce
 * (~40% of fresh connections on loopback), connection setup throws RangeError
 * ERR_OUT_OF_RANGE ("offset is out of range ... Received 5/9") — or, through
 * the neo4j:// routing path, ServiceUnavailable "no routing servers".
 *
 * package.json pins neo4j-driver to ~5.27 (last line without the manifest
 * handshake; 40/40 clean). This retry is the backstop if the driver is bumped:
 * nothing has been sent to the server at that point, so retrying on a fresh
 * connection is always safe — for reads and writes alike.
 */
const HANDSHAKE_RETRIES = 12;
// Failures come in bursts when reconnecting immediately (same timing -> same
// segmentation), so back off a little more on each attempt.
const backoff = (attempt: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, 15 * (attempt + 1)));

function isHandshakeFlake(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  // The driver sometimes re-wraps the RangeError (different code, same text).
  return (
    code === "ERR_OUT_OF_RANGE" ||
    (typeof message === "string" && /ERR_OUT_OF_RANGE|"offset" is out of range/.test(message))
  );
}

export function boltDriver(options: BoltOptions): CypherDriver {
  let driver: Driver | null = null;

  const getDriver = (): Driver => {
    if (!driver) {
      const auth =
        options.user !== undefined
          ? neo4j.auth.basic(options.user, options.password ?? "")
          : neo4j.auth.bearer(options.token ?? "");
      driver = neo4j.driver(options.url, auth, {
        disableLosslessIntegers: true, // ids < 2^53, so plain JS numbers on the way back are exact
      });
    }
    return driver;
  };

  const asRows = <T>(result: { records: { keys: PropertyKey[]; get(key: never): unknown }[] }): T[] =>
    result.records.map(
      (record) =>
        Object.fromEntries(
          (record.keys as string[]).map((column) => [column, record.get(column as never)]),
        ) as T,
    );

  const boltDriverInstance: CypherDriver = {
    // A plain JS number packs as FLOAT over Bolt and is rejected as a node id.
    int: (value: number) => neo4j.int(value),

    async run<T>(query: string, params: Record<string, unknown> = {}): Promise<T[]> {
      for (let attempt = 0; ; attempt++) {
        const session = getDriver().session();
        try {
          const result = await session.run(query, params);
          const rows = result.records.map(
            (record) =>
              Object.fromEntries(record.keys.map((column) => [column, record.get(column)])) as T,
          );
          // Closed inside the try: the flake can also surface when the failed
          // connection is released.
          await session.close();
          return rows;
        } catch (error) {
          await session.close().catch(() => undefined);
          if (!isHandshakeFlake(error) || attempt >= HANDSHAKE_RETRIES) throw error;
          if (process.env.HYMEM_DEBUG) {
            console.error(`[bolt] handshake flake, retrying (${attempt + 1}/${HANDSHAKE_RETRIES})`);
          }
          await backoff(attempt);
        }
      }
    },

    async close() {
      await driver?.close();
      driver = null;
    },
  };

  if (options.transactions) {
    /**
     * One managed write transaction. `executeWrite` also retries on the
     * transient errors Neo4j raises under contention, which is exactly the
     * case this exists to handle — so the retry is a feature, not incidental.
     */
    boltDriverInstance.transaction = async function transaction<T>(
      body: (tx: CypherDriver) => Promise<T>,
    ): Promise<T> {
      const session = getDriver().session();
      try {
        return await session.executeWrite(async (tx) => {
          const scoped: CypherDriver = {
            int: boltDriverInstance.int,
            async run<R>(query: string, params: Record<string, unknown> = {}): Promise<R[]> {
              return asRows<R>(await tx.run(query, params));
            },
            async close() {},
          };
          return body(scoped);
        });
      } finally {
        await session.close().catch(() => undefined);
      }
    };
  }

  return boltDriverInstance;
}

export interface BoltConnectOptions extends Partial<BoltOptions> {
  /** Supply a pre-built driver instead of a url — useful for pooling or tests. */
  driver?: CypherDriver;
}

function connect(
  options: BoltConnectOptions,
  dialect: Dialect,
  defaultUrl: string,
): MemoryStore {
  const driver = options.driver ?? boltDriver({ ...options, url: options.url ?? defaultUrl });
  return cypherStore({ driver, dialect });
}

/**
 * HydraDB over Bolt. Token auth by default; pass user/password for basic auth.
 *
 * `atomicSupersede` is false here: HydraDB's Cypher subset exposes no
 * multi-statement transaction, so concurrent writers can race for one
 * (subject, attribute) slot. Single-writer ingest is correct.
 */
export const hydradb = (options: BoltConnectOptions = {}): MemoryStore =>
  connect({ transactions: false, ...options }, HYDRADB, "neo4j://127.0.0.1:7687");

/** Neo4j 5.x over Bolt. Supersession runs in one managed write transaction. */
export const neo4jStore = (options: BoltConnectOptions = {}): MemoryStore =>
  connect({ transactions: true, ...options }, NEO4J, "neo4j://127.0.0.1:7687");

/** Memgraph over Bolt. Supersession runs in one managed write transaction. */
export const memgraph = (options: BoltConnectOptions = {}): MemoryStore =>
  connect({ transactions: true, ...options }, MEMGRAPH, "bolt://127.0.0.1:7687");

export { HYDRADB, NEO4J, MEMGRAPH } from "@hymem/core/stores/cypher";
export type { CypherDriver, Dialect } from "@hymem/core/stores/cypher";
