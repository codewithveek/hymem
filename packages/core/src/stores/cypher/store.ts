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
import { scopedKey } from "../../core/ids.js";
import type { MemoryStore, StoreCapabilities } from "../../core/ports.js";
import type { SearchQuery, SessionRecord, StoredFact } from "../../core/types.js";
import type { CypherDriver } from "./driver.js";
import { HYDRADB, type Dialect } from "./dialect.js";

export interface CypherStoreOptions {
  driver: CypherDriver;
  dialect?: Dialect;
}

/** Labels this store owns; used to wipe a graph (no label-less MATCH exists on HydraDB). */
const LABELS = ["Fact", "Entity", "Session"] as const;

interface FactRow {
  key: string;
  namespace: string;
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

/**
 * A graph id is opaque here: an encoded integer on dialects that demand one,
 * a namespaced string otherwise. Only the driver knows the wire encoding.
 */
type GraphId = unknown;

type PropertyValue = string | number | boolean | GraphId;

interface NodeUpsert {
  id: GraphId;
  properties: Record<string, PropertyValue | undefined>;
}

interface EdgeUpsert {
  source: GraphId;
  destination: GraphId;
}

export function cypherStore(options: CypherStoreOptions): MemoryStore {
  const { driver } = options;
  const dialect = options.dialect ?? HYDRADB;

  const capabilities: StoreCapabilities = {
    vectorSearch: false,
    // True only when the driver can wrap supersede() in one transaction.
    // Neo4j and Memgraph can; HydraDB's Cypher subset exposes no such thing,
    // so it says so rather than pretending.
    atomicSupersede: driver.transaction !== undefined,
  };

  /**
   * Domain key -> graph id. Integer dialects get a stable 52-bit hash (kept
   * exact as a JS number); everything else uses the namespaced string.
   */
  const graphId = (kind: string, key: string): GraphId => {
    if (!dialect.integerIds) return `${kind}:${key}`;
    const hex = createHash("sha256").update(`${kind}:${key}`).digest("hex").slice(0, 13);
    return driver.int(parseInt(hex, 16));
  };

  // Fact ids already embed the namespace (core hashes it in). Entity and
  // session keys do NOT, so they are scoped here — otherwise two tenants would
  // share one (:Entity {name: "user"}) node and their facts would interlink.
  const factGraphId = (factId: string) => graphId("fact", factId);
  const entityGraphId = (namespace: string, entityName: string) =>
    graphId("entity", `${namespace}\u0000${entityName}`);
  const sessionGraphId = (namespace: string, sessionId: string) =>
    graphId("session", `${namespace}\u0000${sessionId}`);

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
    session: CypherDriver = driver,
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
    await session.run(
      `UNWIND $rows AS row
       MATCH (s:${sourceLabel} {id: row.src}), (d:${destinationLabel} {id: row.dst})
       MERGE (s)-[r:${type} {id: row.rid}]->(d)`,
      { rows },
    );
  }

  const FACT_RETURN = `f.key AS key, f.namespace AS namespace, f.subject AS subject, f.attribute AS attribute,
       f.value AS value, f.text AS text, f.observed_at AS observed_at,
       f.session_id AS session_id, f.status AS status,
       f.valid_from AS valid_from, f.valid_to AS valid_to,
       f.entities_json AS entities_json`;

  const toStoredFact = (row: FactRow): StoredFact => ({
    id: row.key,
    namespace: row.namespace,
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

  let closing: Promise<void> | undefined;

  return {
    capabilities,

    async putSession(namespace: string, session: SessionRecord, previousSessionId?: string) {
      await upsertNodes("Session", [
        {
          id: sessionGraphId(namespace, session.id),
          properties: {
            key: session.id,
            namespace,
            ts: session.ts,
            idx: dialect.integerIds ? driver.int(session.idx) : session.idx,
            speaker: session.speaker,
          },
        },
      ]);
      if (previousSessionId) {
        await upsertNodes("Session", [
          {
            id: sessionGraphId(namespace, previousSessionId),
            properties: { key: previousSessionId, namespace },
          },
        ]);
        await mergeEdges("Session", "NEXT", "Session", [
          {
            source: sessionGraphId(namespace, previousSessionId),
            destination: sessionGraphId(namespace, session.id),
          },
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
            namespace: incomingFact.namespace,
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
      // A session node is identified by (namespace, sessionId), and the port
      // puts no same-namespace restriction on a batch — so dedupe on the pair,
      // not on the session id. Keying every session off the first fact's
      // namespace would leave later facts pointing at nodes nobody created,
      // and an engine that requires both endpoints would reject the edge.
      const sessionsByGraphKey = new Map<string, { namespace: string; sessionId: string }>();
      for (const incomingFact of incomingFacts) {
        const { namespace, sessionId } = incomingFact;
        sessionsByGraphKey.set(scopedKey(namespace, sessionId), { namespace, sessionId });
      }
      await upsertNodes(
        "Session",
        [...sessionsByGraphKey.values()].map(({ namespace, sessionId }) => ({
          id: sessionGraphId(namespace, sessionId),
          properties: { key: sessionId, namespace },
        })),
      );
      await mergeEdges(
        "Fact",
        "STATED_IN",
        "Session",
        incomingFacts.map((incomingFact) => ({
          source: factGraphId(incomingFact.id),
          destination: sessionGraphId(incomingFact.namespace, incomingFact.sessionId),
        })),
      );
    },

    async linkEntities(namespace: string, links) {
      if (links.length === 0) return;
      // mergeEdges matches its source by id alone, so an unchecked fact id
      // would let this namespace hang an ABOUT edge off another tenant's fact —
      // a write outside the namespace, which the port forbids outright. One
      // MATCH per distinct id, the same shape deleteFacts uses, because the
      // restrictive dialects offer no way to check a list of ids at once.
      const ownedFactIds = new Set<string>();
      for (const factId of new Set(links.map((link) => link.factId))) {
        const owned = await driver.run<{ key: string }>(
          `MATCH (f:Fact {id: $id}) WHERE f.namespace = $namespace RETURN f.key AS key`,
          { id: factGraphId(factId), namespace },
        );
        if (owned.length > 0) ownedFactIds.add(factId);
      }
      const ownedLinks = links.filter((link) => ownedFactIds.has(link.factId));
      if (ownedLinks.length === 0) return;

      const entityNames = [...new Set(ownedLinks.map((link) => link.entity))];
      await upsertNodes(
        "Entity",
        entityNames.map((entityName) => ({
          id: entityGraphId(namespace, entityName),
          properties: { name: entityName, namespace },
        })),
      );
      await mergeEdges(
        "Fact",
        "ABOUT",
        "Entity",
        ownedLinks.map((link) => ({
          source: factGraphId(link.factId),
          destination: entityGraphId(namespace, link.entity),
        })),
      );
    },

    /**
     * Find the facts this one overwrites, close them, and chain them.
     *
     * Wrapped in one transaction where the driver offers it (Neo4j, Memgraph),
     * which closes the window in which two writers both see the slot unclaimed.
     * HydraDB has no such facility, so there the three statements are separate
     * round trips: single-writer ingest is correct, concurrent writers can race,
     * and `capabilities.atomicSupersede` reports which one you have.
     */
    async supersede(incoming: StoredFact) {
      const run = async (session: CypherDriver): Promise<string[]> => {
        const rows = await session.run<{ key: string }>(
          `MATCH (old:Fact)
           WHERE old.namespace = $namespace AND old.status = 'active' AND old.id <> $id
             AND old.subject = $subject AND old.attribute = $attribute
             AND old.value <> $value AND old.observed_at < $ts
           RETURN old.key AS key`,
          {
            namespace: incoming.namespace,
            id: factGraphId(incoming.id),
            subject: incoming.subject,
            attribute: incoming.attribute,
            value: incoming.value,
            ts: incoming.observedAt,
          },
        );
        const supersededIds = rows.map((row) => row.key);
        if (supersededIds.length === 0) return [];

        for (const supersededId of supersededIds) {
          await session.run(
            `MATCH (f:Fact {id: $id}) SET f.status = 'superseded', f.valid_to = $ts`,
            { id: factGraphId(supersededId), ts: incoming.observedAt },
          );
        }
        await mergeEdges(
          "Fact",
          "SUPERSEDES",
          "Fact",
          supersededIds.map((supersededId) => ({
            source: factGraphId(incoming.id),
            destination: factGraphId(supersededId),
          })),
          session,
        );
        return supersededIds;
      };

      return driver.transaction ? driver.transaction(run) : run(driver);
    },

    async search(query: SearchQuery) {
      const limit = Math.floor(query.limit);
      // `limit` is an upper bound, so zero means zero — and asking an engine
      // for LIMIT 0 is a round trip whose rows are thrown away regardless.
      if (query.entities.length === 0 || !Number.isFinite(limit) || limit <= 0) return [];
      const attributes = query.attributes ?? [];
      // No IN on HydraDB, so an attribute filter is an OR chain of equalities.
      // A WHERE clause is always present now (the namespace check), so the
      // attribute filter is appended with AND rather than opening its own.
      const attributeFilter = attributes.length
        ? dialect.supportsIn
          ? `AND f.attribute IN $attrs`
          : `AND (${attributes.map((_, index) => `f.attribute = $a${index}`).join(" OR ")})`
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
          // The entity node id is already namespace-scoped; the property check
          // is defence in depth, so a hash collision cannot cross tenants.
          `MATCH (f:Fact)-[:ABOUT]->(e:Entity {id: $eid})
           WHERE f.namespace = $namespace ${attributeFilter}
           RETURN ${FACT_RETURN}
           ORDER BY observed_at DESC
           LIMIT ${limit}`,
          { eid: entityGraphId(query.namespace, entityName), namespace: query.namespace, ...attributeParams },
        );
        for (const row of rows) {
          if (seenFactIds.has(row.key)) continue;
          seenFactIds.add(row.key);
          matches.push(toStoredFact(row));
        }
      }
      matches.sort(byObservedAtAscending);
      return matches.slice(Math.max(0, matches.length - limit));
    },

    async getSupersededBy(namespace: string, factId: string) {
      const rows = await driver.run<{ value: string; observed_at: string }>(
        `MATCH (f:Fact {id: $id})-[:SUPERSEDES]->(o:Fact)
         WHERE o.namespace = $namespace
         RETURN o.value AS value, o.observed_at AS observed_at`,
        { id: factGraphId(factId), namespace },
      );
      return rows.map((row) => ({ value: row.value, observedAt: row.observed_at }));
    },

    async listFacts(namespace: string, entityName?: string) {
      const rows = await driver.run<FactRow>(
        entityName
          ? `MATCH (f:Fact)-[:ABOUT]->(e:Entity {id: $eid})
             WHERE f.namespace = $namespace
             RETURN ${FACT_RETURN}
             ORDER BY observed_at`
          : `MATCH (f:Fact)
             WHERE f.namespace = $namespace
             RETURN ${FACT_RETURN}
             ORDER BY observed_at`,
        entityName
          ? { eid: entityGraphId(namespace, entityName), namespace }
          : { namespace },
      );
      return rows.map(toStoredFact).sort(byObservedAtAscending);
    },

    async deleteFacts(namespace: string, factIds: string[]) {
      for (const factId of factIds) {
        // The id predicate cannot carry the namespace check (HydraDB has no
        // AND in a node pattern), so verify ownership before deleting.
        const owned = await driver.run<{ key: string }>(
          `MATCH (f:Fact {id: $id}) WHERE f.namespace = $namespace RETURN f.key AS key`,
          { id: factGraphId(factId), namespace },
        );
        if (owned.length === 0) continue;
        await driver.run(`MATCH (f:Fact {id: $id}) DETACH DELETE f`, { id: factGraphId(factId) });
      }
    },

    /** Scoped wipe: other tenants in this graph are untouched. */
    async clear(namespace: string) {
      for (const label of LABELS) {
        await driver.run(`MATCH (n:${label}) WHERE n.namespace = $namespace DETACH DELETE n`, {
          namespace,
        });
      }
    },

    async close() {
      // The port promises a second close is safe; a driver's session or pool
      // usually does not. Memoise the first call, and drop the memo if it fails
      // so a close that errored can be retried rather than remembered as done.
      closing ??= driver.close().catch((error: unknown) => {
        closing = undefined;
        throw error;
      });
      await closing;
    },
  };
}
