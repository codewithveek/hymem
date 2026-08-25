/**
 * The Cypher driver seam.
 *
 * `cypherStore` is written once against this interface, so HydraDB, Neo4j and
 * Memgraph share one implementation and differ only in a Dialect. The interface
 * lives here in the dependency-free core; the Bolt implementation ships in
 * `@hymem/bolt`, which carries the `neo4j-driver` peer dependency.
 */
export interface CypherDriver {
  run<T = Record<string, unknown>>(query: string, params?: Record<string, unknown>): Promise<T[]>;
  /**
   * Encode a JS integer as whatever the wire protocol needs for an integer.
   *
   * Bolt is the reason this exists: a plain JS number packs as FLOAT and
   * HydraDB rejects it as a node id. Putting the encoder on the driver rather
   * than importing neo4j-driver directly keeps `cypherStore` free of any
   * dependency, which is what lets it live in the core package while the driver
   * ships separately.
   */
  int(value: number): unknown;
  /**
   * Run `body` inside a single write transaction, rolling back on throw.
   *
   * Optional: a driver whose engine exposes no multi-statement transaction
   * omits it, and the store falls back to separate round trips and reports
   * `atomicSupersede: false` rather than pretending. Neo4j and Memgraph have
   * this; HydraDB's Cypher subset does not.
   */
  transaction?<T>(body: (tx: CypherDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
