/**
 * Cypher-family store factories. These are what a user imports:
 *
 *   import { hydradb } from "hymem/stores/cypher";
 *   const memory = createMemory({ store: hydradb({ url, token }), model });
 *
 * When the packages are split these become @hymem/hydradb, @hymem/neo4j and
 * @hymem/memgraph — thin re-exports over the shared implementation, so each
 * declares only the peer dependency it actually needs.
 */
import type { MemoryStore } from "../../core/ports.js";
import { boltDriver, type BoltOptions, type CypherDriver } from "./driver.js";
import { cypherStore } from "./store.js";
import { HYDRADB, MEMGRAPH, NEO4J, type Dialect } from "./dialect.js";

export interface CypherConnectOptions extends Partial<BoltOptions> {
  /** Supply a pre-built driver instead of a url — useful for pooling or tests. */
  driver?: CypherDriver;
}

function connect(opts: CypherConnectOptions, dialect: Dialect, defaultUrl: string): MemoryStore {
  const driver = opts.driver ?? boltDriver({ ...opts, url: opts.url ?? defaultUrl });
  return cypherStore({ driver, dialect });
}

/** HydraDB over Bolt. Token auth by default; pass user/password for basic auth. */
export const hydradb = (opts: CypherConnectOptions = {}): MemoryStore =>
  connect(opts, HYDRADB, "neo4j://127.0.0.1:7687");

/** Neo4j 5.x over Bolt. */
export const neo4j = (opts: CypherConnectOptions = {}): MemoryStore =>
  connect(opts, NEO4J, "neo4j://127.0.0.1:7687");

/** Memgraph over Bolt. */
export const memgraph = (opts: CypherConnectOptions = {}): MemoryStore =>
  connect(opts, MEMGRAPH, "bolt://127.0.0.1:7687");

export { cypherStore, boltDriver };
export { HYDRADB, NEO4J, MEMGRAPH };
export type { Dialect, CypherDriver, BoltOptions };
