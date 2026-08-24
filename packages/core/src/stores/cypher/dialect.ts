/**
 * What differs between Cypher engines. Everything the store does is expressed
 * in terms of these three flags, so adding Memgraph or AGE is a dialect entry
 * rather than a new adapter.
 *
 * HydraDB's Cypher subset (see cypher-compat.md in the HydraDB repo) is the
 * restrictive end and therefore the shape the store writes by default:
 *
 *   node upsert   UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:Label, n.p = row.p
 *   edge upsert   UNWIND $rows AS row MATCH (s:L1 {id: row.src}), (d:L2 {id: row.dst})
 *                   MERGE (s)-[r:TYPE {id: row.rid}]->(d)
 *   update        MATCH (n:Label {id: $id}) SET n.p = $v        (also REMOVE / DETACH DELETE)
 *   read          MATCH (...)-[:TYPE]->(...) WHERE a = $x OR ... RETURN n.p AS p ORDER BY p LIMIT k
 *
 * Rules that bite on HydraDB:
 *   - Node and relationship ids are NON-NEGATIVE INTEGERS and must arrive as
 *     Bolt INTs: a plain JS number packs as FLOAT and is rejected.
 *   - Standalone CREATE/MERGE accept only relationship paths; a node on its
 *     own is created through the UNWIND form above (Bolt only).
 *   - MATCH may only be followed by SET / REMOVE / DELETE — never MERGE/CREATE.
 *   - WHERE: property comparisons joined by AND/OR/NOT. No IN, CONTAINS,
 *     IS NULL, coalesce(). Missing properties read back as null.
 *   - MATCH (n) DETACH DELETE n is rejected: a node-only MATCH needs a label,
 *     id, or property predicate.
 */
export interface Dialect {
  name: string;
  /**
   * Node ids must be non-negative Bolt integers. String domain keys are hashed
   * into 52-bit ints and the original is kept on the node as `key`.
   */
  integerIds: boolean;
  /** Supports `x IN $list`. Without it, multi-value filters become OR chains. */
  supportsIn: boolean;
  /** Supports `null` property values. Without it, clearing means REMOVE. */
  supportsNullProperties: boolean;
}

export const HYDRADB: Dialect = {
  name: "hydradb",
  integerIds: true,
  supportsIn: false,
  supportsNullProperties: false,
};

export const NEO4J: Dialect = {
  name: "neo4j",
  integerIds: false,
  supportsIn: true,
  supportsNullProperties: true,
};

export const MEMGRAPH: Dialect = { ...NEO4J, name: "memgraph" };
