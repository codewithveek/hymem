import { createHash } from "node:crypto";
import neo4j, { Driver, Integer } from "neo4j-driver";
import { config } from "./config.js";

/**
 * HydraDB speaks Bolt 5.x, so the official Neo4j JS driver works, and Bolt
 * gives us parameterized queries (the HTTP API takes none).
 *
 * Auth over Bolt: `neo4j.auth.bearer(token)` is accepted by the current
 * graph-node build (the repo's scripts/runtime_smoke.sh uses
 * `("neo4j", token)` basic auth with the Python driver — either works).
 *
 * ---------------------------------------------------------------------------
 * HydraDB's Cypher subset (see cypher-compat.md in the HydraDB repo). Every
 * statement in this project is one of these shapes, verified live:
 *
 *   node upsert   UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:Label, n.p = row.p
 *   edge upsert   UNWIND $rows AS row MATCH (s:L1 {id: row.src}), (d:L2 {id: row.dst})
 *                   MERGE (s)-[r:TYPE {id: row.rid}]->(d)
 *   update        MATCH (n:Label {id: $id}) SET n.p = $v        (also REMOVE / DETACH DELETE)
 *   read          MATCH (...)-[:TYPE]->(...) WHERE a = $x OR ... RETURN n.p AS p ORDER BY p LIMIT k
 *
 * Rules that bite:
 *   - Node and relationship ids are NON-NEGATIVE INTEGERS and must arrive as
 *     Bolt INTs: wrap with neo4j.int() — a plain JS number packs as FLOAT and
 *     is rejected ("node id property must be an integer").
 *   - Standalone CREATE/MERGE accept only relationship paths; a node on its
 *     own is created through the UNWIND form above (Bolt only).
 *   - MATCH may only be followed by SET / REMOVE / DELETE — never MERGE/CREATE.
 *   - WHERE: property comparisons joined by AND/OR/NOT. No IN, CONTAINS,
 *     IS NULL, coalesce(). Missing properties read back as null.
 *   - MATCH (n) DETACH DELETE n is rejected: a node-only MATCH needs a label,
 *     id, or property predicate.
 * ---------------------------------------------------------------------------
 */
let driver: Driver | null = null;

function getDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(config.boltUrl, neo4j.auth.bearer(config.token), {
      disableLosslessIntegers: true, // ids < 2^53, so plain JS numbers on the way back are exact
    });
  }
  return driver;
}

/** Wrap a JS integer as a Bolt INT (required for every id parameter). */
export const int = (n: number): Integer => neo4j.int(n);

/**
 * Stable 52-bit graph id for a string key (HydraDB ids are non-negative
 * integers; 52 bits keeps them exact as JS numbers). The key itself is stored
 * on the node as `key` so the human-readable id survives the round trip.
 */
export function nodeId(key: string): Integer {
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 13);
  return neo4j.int(parseInt(hex, 16));
}

/**
 * Bolt handshake flake (HydraDB ↔ neo4j-driver-js ≥ 5.28): graph-node answers
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
// Failures come in bursts when reconnecting immediately (same timing → same
// segmentation), so back off a little more on each attempt.
const backoff = (attempt: number) => new Promise<void>((r) => setTimeout(r, 15 * (attempt + 1)));

function isHandshakeFlake(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  // The driver sometimes re-wraps the RangeError (different code, same text).
  return code === "ERR_OUT_OF_RANGE" ||
    (typeof message === "string" && /ERR_OUT_OF_RANGE|"offset" is out of range/.test(message));
}

export async function cypher<T = Record<string, unknown>>(
  query: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    const session = getDriver().session();
    try {
      const res = await session.run(query, params);
      const rows = res.records.map((r) => Object.fromEntries(r.keys.map((k) => [k, r.get(k)])) as T);
      await session.close(); // inside the try: the flake can also surface when the failed connection is released
      return rows;
    } catch (e) {
      await session.close().catch(() => undefined);
      if (!isHandshakeFlake(e) || attempt >= HANDSHAKE_RETRIES) throw e;
      if (process.env.HYDRA_DEBUG) console.error(`[hydra] Bolt handshake flake, retrying (${attempt + 1}/${HANDSHAKE_RETRIES})`);
      await backoff(attempt);
    }
  }
}

/** Property value types HydraDB stores. `undefined` entries are dropped. */
export type PropValue = string | number | boolean | Integer;

export interface NodeRow {
  id: Integer;
  props: Record<string, PropValue | undefined>;
}

/**
 * Idempotent node upsert: `UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:Label, ...`.
 * Rows are grouped by their set of defined property names, since every row in
 * one UNWIND statement must carry every field the SET clause reads.
 */
export async function upsertNodes(label: string, rows: NodeRow[]): Promise<void> {
  const groups = new Map<string, { keys: string[]; rows: Record<string, unknown>[] }>();
  for (const r of rows) {
    const defined = Object.entries(r.props).filter(([, v]) => v !== undefined) as [string, PropValue][];
    const keys = defined.map(([k]) => k).sort();
    const sig = keys.join(",");
    const g = groups.get(sig) ?? { keys, rows: [] };
    g.rows.push({ vertex: r.id, ...Object.fromEntries(defined) });
    groups.set(sig, g);
  }
  for (const { keys, rows: batch } of groups.values()) {
    const sets = [`n:${label}`, ...keys.map((k) => `n.${k} = row.${k}`)].join(", ");
    await cypher(`UNWIND $rows AS row MERGE (n {id: row.vertex}) SET ${sets}`, { rows: batch });
  }
}

export interface EdgeRow {
  src: Integer;
  dst: Integer;
}

/**
 * Idempotent edge upsert between EXISTING nodes (HydraDB errors on a missing
 * endpoint rather than creating a label-less stub). Relationship ids are
 * derived from (src, type, dst) so a re-run is a no-op.
 */
export async function mergeEdges(srcLabel: string, type: string, dstLabel: string, rows: EdgeRow[]): Promise<void> {
  if (rows.length === 0) return;
  const batch = rows.map((e) => ({
    src: e.src, dst: e.dst, rid: nodeId(`${srcLabel}:${e.src}-[${type}]->${dstLabel}:${e.dst}`),
  }));
  await cypher(
    `UNWIND $rows AS row
     MATCH (s:${srcLabel} {id: row.src}), (d:${dstLabel} {id: row.dst})
     MERGE (s)-[r:${type} {id: row.rid}]->(d)`,
    { rows: batch },
  );
}

/** Labels this project writes; used to wipe a graph (no label-less MATCH exists). */
export const LABELS = ["Fact", "Entity", "Session", "Probe"] as const;

export async function deleteAll(labels: readonly string[] = LABELS): Promise<void> {
  for (const l of labels) await cypher(`MATCH (n:${l}) DETACH DELETE n`);
}

/**
 * HTTP fallback (no parameters — the documented body is {cell_id, query}).
 * Use only for fixed queries or connectivity checks; never interpolate
 * untrusted strings into Cypher here.
 */
export async function cypherHttp(query: string, consistency: "causal" | "strong" = "causal"): Promise<unknown> {
  const res = await fetch(`${config.httpUrl}/v1/graphs/${config.graphId}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "X-Graph-Namespace": config.namespace,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ cell_id: config.cellId, query, consistency }),
  });
  if (!res.ok) throw new Error(`HydraDB HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function closeHydra(): Promise<void> {
  await driver?.close();
  driver = null;
}
