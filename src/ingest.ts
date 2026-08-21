import { cypher, int, mergeEdges, upsertNodes } from "./hydra.js";
import { entityNodeId, factNodeId, sessionNodeId } from "./ids.js";
import { extractFacts } from "./extract.js";
import type { Fact, SessionInput } from "./types.js";

/**
 * Writes stay inside HydraDB's Cypher subset (dialect note in src/hydra.ts):
 * batched UNWIND node upserts, batched UNWIND edge merges between matched
 * nodes, and MATCH ... SET / REMOVE for property updates. No MATCH ... MERGE,
 * no coalesce(), integer ids everywhere.
 *
 * Fact identity is hash(subject|attribute|value), so re-stating a fact later
 * re-activates the SAME node: status/valid_from are refreshed and valid_to is
 * cleared, and the supersession pass then closes whichever other value was
 * active in between. Re-ingesting the same history is idempotent.
 */
export async function ingestSession(session: SessionInput, prevSessionId?: string): Promise<Fact[]> {
  const facts = await extractFacts(session);
  const sid = sessionNodeId(session.id);

  // 1. Session node + timeline backbone.
  await upsertNodes("Session", [{ id: sid, props: { key: session.id, ts: session.ts, idx: int(session.idx) } }]);
  if (prevSessionId) {
    await mergeEdges("Session", "NEXT", "Session", [{ src: sessionNodeId(prevSessionId), dst: sid }]);
  }
  if (facts.length === 0) return facts;

  // 2. Fact nodes. session_id is stored as a property so reads never need
  //    an OPTIONAL MATCH for provenance.
  await upsertNodes("Fact", facts.map((f) => ({
    id: factNodeId(f.id),
    props: {
      key: f.id, subject: f.subject, attribute: f.attribute, value: f.value, text: f.text,
      observed_at: f.observedAt, session_id: f.sessionId,
      status: "active", valid_from: f.observedAt,
    },
  })));
  // A re-activated fact may still carry valid_to from an earlier supersession.
  for (const f of facts) {
    await cypher(`MATCH (n:Fact {id: $id}) REMOVE n.valid_to`, { id: factNodeId(f.id) });
  }

  // 3. Provenance + entity edges (batched; endpoints must already exist).
  await mergeEdges("Fact", "STATED_IN", "Session", facts.map((f) => ({ src: factNodeId(f.id), dst: sid })));
  const entityNames = [...new Set(facts.flatMap((f) => f.entities))];
  if (entityNames.length > 0) {
    await upsertNodes("Entity", entityNames.map((name) => ({ id: entityNodeId(name), props: { name } })));
    await mergeEdges("Fact", "ABOUT", "Entity", facts.flatMap((f) =>
      f.entities.map((name) => ({ src: factNodeId(f.id), dst: entityNodeId(name) })),
    ));
  }

  // 4. Supersession: read candidates, close each, then chain (new)-[:SUPERSEDES]->(old).
  for (const f of facts) {
    const fid = factNodeId(f.id);
    const olds = await cypher<{ oldId: number }>(
      `MATCH (old:Fact)
       WHERE old.status = 'active' AND old.id <> $id
         AND old.subject = $subject AND old.attribute = $attribute
         AND old.value <> $value AND old.observed_at < $ts
       RETURN old.id AS oldId`,
      { id: fid, subject: f.subject, attribute: f.attribute, value: f.value, ts: f.observedAt },
    );
    if (olds.length === 0) continue;
    for (const { oldId } of olds) {
      await cypher(
        `MATCH (old:Fact {id: $oldId}) SET old.status = 'superseded', old.valid_to = $ts`,
        { oldId: int(oldId), ts: f.observedAt },
      );
    }
    await mergeEdges("Fact", "SUPERSEDES", "Fact", olds.map(({ oldId }) => ({ src: fid, dst: int(oldId) })));
  }
  return facts;
}

export async function ingestHistory(sessions: SessionInput[]): Promise<number> {
  const ordered = [...sessions].sort((a, b) => a.ts.localeCompare(b.ts));
  let total = 0;
  let prev: string | undefined;
  for (const s of ordered) {
    const facts = await ingestSession(s, prev);
    total += facts.length;
    prev = s.id;
    console.error(`  ingested ${s.id} (${facts.length} facts)`);
  }
  return total;
}
