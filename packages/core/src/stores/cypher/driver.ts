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
  close(): Promise<void>;
}
