/**
 * MemoryStore over a Cypher property graph.
 *
 * Graph shape:
 *   (:Fact {key, subject, attribute, value, text, observed_at, session_id,
 *           status, valid_from, valid_to?, entities_json})
 *   (:Fact)-[:STATED_IN]->(:Session {key, ts, idx})
 *   (:Fact)-[:ABOUT]->(:Entity {name})
 *   (:Fact)-[:SUPERSEDES]->(:Fact)
 *   (:Session)-[:NEXT]->(:Session)
 *
 * Every id parameter is derived from the domain's string key, so the integer
 * ids HydraDB requires never escape this file — the rest of hymem only ever
 * sees `fact.id` as the 24-char hash it always was.
 */
import { createHash } from "node:crypto";
import type { MemoryStore, StoreCapabilities } from "../../core/ports.js";
import type { FactKey, SearchQuery, SessionRecord, StoredFact } from "../../core/types.js";
import { int, type CypherDriver, type Integer } from "./driver.js";
import { HYDRADB, type Dialect } from "./dialect.js";

export interface CypherStoreOptions {
  driver: CypherDriver;
  dialect?: Dialect;
}

/** Labels this store owns; used to wipe a graph (no label-less MATCH exists on HydraDB). */
const LABELS = ["Fact", "Entity", "Session"] as const;

interface FactRow {
  key: string;
  subject: string;
  attribute: string;
  value: string;
  text: string;
  observed_at: string;
  session_id: string;
  status: string;
  valid_from: string;
  valid_to: string | null;
  entities_json: string | null;
}

type PropertyValue = string | number | boolean | Integer;

interface NodeUpsert {
  id: Integer | string;
  properties: Record<string, PropertyValue | undefined>;
}

interface EdgeUpsert {
  source: Integer | string;
  destination: Integer | string;
}

export function cypherStore(options: CypherStoreOptions): MemoryStore {
  const { driver } = options;
  const dialect = options.dialect ?? HYDRADB;

  const capabilities: StoreCapabilities = {
    vectorSearch: false,
    // The find -> close -> link trio is issued as separate statements; no
    // adapter-level transaction wraps them yet.
    transactions: false,
  };

  /**
   * Domain key -> graph id. Integer dialects get a stable 52-bit hash (kept
   * exact as a JS number); everything else uses the namespaced string.
   */
  const graphId = (kind: string, key: string): Integer | string => {
    if (!dialect.integerIds) return `${kind}:${key}`;
    const hex = createHash("sha256").update(`${kind}:${key}`).digest("hex").slice(0, 13);
    return int(parseInt(hex, 16));
  };

  const factGraphId = (factId: string) => graphId("fact", factId);
  const entityGraphId = (entityName: string) => graphId("entity", entityName);
  const sessionGraphId = (sessionId: string) => graphId("session", sessionId);

  /**
   * Idempotent node upsert. Rows are grouped by their set of defined property
   * names, since every row in one UNWIND must carry every field SET reads.
   */
  async function upsertNodes(label: string, nodes: NodeUpsert[]): Promise<void> {
    if (nodes.length === 0) return;
    const groupsBySignature = new Map<
      string,
      { propertyNames: string[]; rows: Record<string, unknown>[] }
    >();
    for (const node of nodes) {
      const definedProperties = Object.entries(node.properties).filter(
        ([, value]) => value !== undefined,
      ) as [string, PropertyValue][];
      const propertyNames = definedProperties.map(([name]) => name).sort();
      const signature = propertyNames.join(",");
      const group = groupsBySignature.get(signature) ?? { propertyNames, rows: [] };
      group.rows.push({ vertex: node.id, ...Object.fromEntries(definedProperties) });
      groupsBySignature.set(signature, group);
    }
    for (const { propertyNames, rows } of groupsBySignature.values()) {
      const assignments = [
        `n:${label}`,
        ...propertyNames.map((name) => `n.${name} = row.${name}`),
      ].join(", ");
      await driver.run(`UNWIND $rows AS row MERGE (n {id: row.vertex}) SET ${assignments}`, { rows });
    }
  }

  /**
   * Idempotent edge upsert between EXISTING nodes (HydraDB errors on a missing
   * endpoint rather than creating a label-less stub). Relationship ids are
   * derived from (source, type, destination) so a re-run is a no-op.
   */
  async function mergeEdges(
    sourceLabel: string,
    type: string,
    destinationLabel: string,
    edges: EdgeUpsert[],
  ): Promise<void> {
    if (edges.length === 0) return;
    const rows = edges.map((edge) => ({
      src: edge.source,
      dst: edge.destination,
      rid: graphId(
        "rel",
        `${sourceLabel}:${edge.source}-[${type}]->${destinationLabel}:${edge.destination}`,
      ),
    }));
    await driver.run(
      `UNWIND $rows AS row
       MATCH (s:${sourceLabel} {id: row.src}), (d:${destinationLabel} {id: row.dst})
       MERGE (s)-[r:${type} {id: row.rid}]->(d)`,
      { rows },
    );
  }

  const FACT_RETURN = `f.key AS key, f.subject AS subject, f.attribute AS attribute,
       f.value AS value, f.text AS text, f.observed_at AS observed_at,
       f.session_id AS session_id, f.status AS status,
       f.valid_from AS valid_from, f.valid_to AS valid_to,
       f.entities_json AS entities_json`;

  const toStoredFact = (row: FactRow): StoredFact => ({
    id: row.key,
    subject: row.subject,
    attribute: row.attribute,
    value: row.value,
    text: row.text,
    entities: row.entities_json ? (JSON.parse(row.entities_json) as string[]) : [],
    observedAt: row.observed_at,
    sessionId: row.session_id,
    status: row.status === "superseded" ? "superseded" : "active",
    validFrom: row.valid_from,
    validTo: row.valid_to ?? null,
  });

  const byObservedAtAscending = (earlier: StoredFact, later: StoredFact) =>
    earlier.observedAt.localeCompare(later.observedAt);

  return {
    capabilities,

    async putSession(session: SessionRecord, previousSessionId?: string) {
      await upsertNodes("Session", [
        {
          id: sessionGraphId(session.id),
          properties: {
            key: session.id,
            ts: session.ts,
            idx: dialect.integerIds ? int(session.idx) : session.idx,
          },
        },
      ]);
      if (previousSessionId) {
        await upsertNodes("Session", [
          { id: sessionGraphId(previousSessionId), properties: { key: previousSessionId } },
        ]);
        await mergeEdges("Session", "NEXT", "Session", [
          { source: sessionGraphId(previousSessionId), destination: sessionGraphId(session.id) },
        ]);
      }
    },

    async putFacts(incomingFacts: StoredFact[]) {
      if (incomingFacts.length === 0) return;
      await upsertNodes(
        "Fact",
        incomingFacts.map((incomingFact) => ({
          id: factGraphId(incomingFact.id),
          properties: {
            key: incomingFact.id,
            subject: incomingFact.subject,
            attribute: incomingFact.attribute,
            value: incomingFact.value,
            text: incomingFact.text,
            observed_at: incomingFact.observedAt,
            session_id: incomingFact.sessionId,
            entities_json: JSON.stringify(incomingFact.entities),
            status: "active",
            valid_from: incomingFact.observedAt,
          },
        })),
      );
      // A re-activated fact may still carry valid_to from an earlier
      // supersession; HydraDB cannot store null, so clearing means REMOVE.
      for (const incomingFact of incomingFacts) {
        await driver.run(`MATCH (n:Fact {id: $id}) REMOVE n.valid_to`, {
          id: factGraphId(incomingFact.id),
        });
      }
      // Provenance edge. Sessions are upserted by putSession, but a caller may
      // write facts for a session the store has not seen, so ensure the node.
      const sessionIds = [...new Set(incomingFacts.map((incomingFact) => incomingFact.sessionId))];
      await upsertNodes(
        "Session",
        sessionIds.map((sessionId) => ({
          id: sessionGraphId(sessionId),
          properties: { key: sessionId },
        })),
      );
      await mergeEdges(
        "Fact",
        "STATED_IN",
        "Session",
        incomingFacts.map((incomingFact) => ({
          source: factGraphId(incomingFact.id),
          destination: sessionGraphId(incomingFact.sessionId),
        })),
      );
    },

    async linkEntities(links) {
      if (links.length === 0) return;
      const entityNames = [...new Set(links.map((link) => link.entity))];
      await upsertNodes(
        "Entity",
        entityNames.map((entityName) => ({
          id: entityGraphId(entityName),
          properties: { name: entityName },
        })),
      );
      await mergeEdges(
        "Fact",
        "ABOUT",
        "Entity",
        links.map((link) => ({
          source: factGraphId(link.factId),
          destination: entityGraphId(link.entity),
        })),
      );
    },

    async findSupersedable(key: FactKey & { before: string; excludeId: string }) {
      const rows = await driver.run<{ key: string }>(
        `MATCH (old:Fact)
         WHERE old.status = 'active' AND old.id <> $id
           AND old.subject = $subject AND old.attribute = $attribute
           AND old.value <> $value AND old.observed_at < $ts
         RETURN old.key AS key`,
        {
          id: factGraphId(key.excludeId),
          subject: key.subject,
          attribute: key.attribute,
          value: key.value,
          ts: key.before,
        },
      );
      return rows.map((row) => row.key);
    },

    async closeFacts(factIds: string[], validTo: string) {
      for (const factId of factIds) {
        await driver.run(
          `MATCH (f:Fact {id: $id}) SET f.status = 'superseded', f.valid_to = $ts`,
          { id: factGraphId(factId), ts: validTo },
        );
      }
    },

    async linkSupersedes(newFactId: string, supersededFactIds: string[]) {
      await mergeEdges(
        "Fact",
        "SUPERSEDES",
        "Fact",
        supersededFactIds.map((supersededId) => ({
          source: factGraphId(newFactId),
          destination: factGraphId(supersededId),
        })),
      );
    },

    async search(query: SearchQuery) {
      const attributes = query.attributes ?? [];
      // No IN on HydraDB, so an attribute filter is an OR chain of equalities.
      const attributeFilter = attributes.length
        ? dialect.supportsIn
          ? `WHERE f.attribute IN $attrs`
          : `WHERE ${attributes.map((_, index) => `f.attribute = $a${index}`).join(" OR ")}`
        : "";
      const attributeParams = dialect.supportsIn
        ? attributes.length
          ? { attrs: attributes }
          : {}
        : Object.fromEntries(attributes.map((attribute, index) => [`a${index}`, attribute]));

      // One anchored traversal per entity, merged in process. DESC + LIMIT
      // keeps the NEWEST matches; the merged result is re-sorted ascending.
      const seenFactIds = new Set<string>();
      const matches: StoredFact[] = [];
      for (const entityName of query.entities) {
        const rows = await driver.run<FactRow>(
          `MATCH (f:Fact)-[:ABOUT]->(e:Entity {id: $eid}) ${attributeFilter}
           RETURN ${FACT_RETURN}
           ORDER BY observed_at DESC
           LIMIT ${Math.max(1, Math.floor(query.limit))}`,
          { eid: entityGraphId(entityName), ...attributeParams },
        );
        for (const row of rows) {
          if (seenFactIds.has(row.key)) continue;
          seenFactIds.add(row.key);
          matches.push(toStoredFact(row));
        }
      }
      matches.sort(byObservedAtAscending);
      return matches.slice(Math.max(0, matches.length - query.limit));
    },

    async getSupersededBy(factId: string) {
      const rows = await driver.run<{ value: string; observed_at: string }>(
        `MATCH (f:Fact {id: $id})-[:SUPERSEDES]->(o:Fact)
         RETURN o.value AS value, o.observed_at AS observed_at`,
        { id: factGraphId(factId) },
      );
      return rows.map((row) => ({ value: row.value, observedAt: row.observed_at }));
    },

    async listFacts(entityName?: string) {
      const rows = await driver.run<FactRow>(
        entityName
          ? `MATCH (f:Fact)-[:ABOUT]->(e:Entity {id: $eid})
             RETURN ${FACT_RETURN}
             ORDER BY observed_at`
          : `MATCH (f:Fact)
             RETURN ${FACT_RETURN}
             ORDER BY observed_at`,
        entityName ? { eid: entityGraphId(entityName) } : {},
      );
      return rows.map(toStoredFact).sort(byObservedAtAscending);
    },

    async deleteFacts(factIds: string[]) {
      for (const factId of factIds) {
        await driver.run(`MATCH (f:Fact {id: $id}) DETACH DELETE f`, { id: factGraphId(factId) });
      }
    },

    async clear() {
      for (const label of LABELS) {
        await driver.run(`MATCH (n:${label}) DETACH DELETE n`);
      }
    },

    async close() {
      await driver.close();
    },
  };
}
