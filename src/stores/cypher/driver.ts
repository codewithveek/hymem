/**
 * Bolt driver seam. One CypherDriver is all the Cypher-family store needs, so
 * HydraDB, Neo4j and Memgraph share a single MemoryStore implementation and
 * differ only in a Dialect (see dialect.ts).
 *
 * Nothing here is hymem-specific — it is connection management and the
 * HydraDB handshake workaround, lifted verbatim from the original hydra.ts.
 */
import neo4j, { type Driver, type Integer } from "neo4j-driver";

export interface CypherDriver {
  run<T = Record<string, unknown>>(query: string, params?: Record<string, unknown>): Promise<T[]>;
  close(): Promise<void>;
}

export interface BoltOptions {
  url: string;
  token?: string;
  /** Basic auth as an alternative to bearer. */
  user?: string;
  password?: string;
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

  return {
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
            console.error(`[cypher] Bolt handshake flake, retrying (${attempt + 1}/${HANDSHAKE_RETRIES})`);
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
}

/** Wrap a JS integer as a Bolt INT (required by dialects with integer ids). */
export const int = (n: number): Integer => neo4j.int(n);
export type { Integer };
