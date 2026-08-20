import { cypher } from "./hydra.js";
import { extractFacts } from "./extract.js";
import type { Fact, SessionInput } from "./types.js";

/**
 * Write one session's facts into the graph, then run the supersession pass.
 *
 * Data model (see README):
 *   (:Session {id, ts, idx})-[:NEXT]->(:Session)
 *   (:Fact {id, subject, attribute, value, text, observed_at, valid_from, valid_to, status})
 *   (:Fact)-[:STATED_IN]->(:Session)
 *   (:Fact)-[:ABOUT]->(:Entity {name})
 *   (:Fact)-[:SUPERSEDES]->(:Fact)
 */
export async function ingestSession(session: SessionInput, prevSessionId?: string): Promise<Fact[]> {
  const facts = await extractFacts(session);

  // 1. Session node + timeline backbone.
  await cypher(
    `MERGE (s:Session {id: $id}) SET s.ts = $ts, s.idx = $idx`,
    { id: session.id, ts: session.ts, idx: session.idx },
  );
  if (prevSessionId) {
    await cypher(
      `MATCH (a:Session {id: $prev}), (b:Session {id: $cur}) MERGE (a)-[:NEXT]->(b)`,
      { prev: prevSessionId, cur: session.id },
    );
  }
  if (facts.length === 0) return facts;

  // 2. Facts + provenance, one batched UNWIND write.
  await cypher(
    `UNWIND $facts AS f
     MATCH (s:Session {id: $sid})
     MERGE (fact:Fact {id: f.id})
       SET fact.subject = f.subject, fact.attribute = f.attribute, fact.value = f.value,
           fact.text = f.text, fact.observed_at = f.observedAt,
           fact.valid_from = coalesce(fact.valid_from, f.observedAt),
           fact.status = coalesce(fact.status, 'active')
     MERGE (fact)-[:STATED_IN]->(s)`,
    { facts, sid: session.id },
  );

  // 3. Entity links (flattened to keep the Cypher inside the supported subset).
  const links = facts.flatMap((f) => f.entities.map((e) => ({ fid: f.id, ename: e })));
  if (links.length > 0) {
    await cypher(
      `UNWIND $links AS l
       MATCH (fact:Fact {id: l.fid})
       MERGE (e:Entity {name: l.ename})
       MERGE (fact)-[:ABOUT]->(e)`,
      { links },
    );
  }

  // 4. Supersession pass: same (subject, attribute), different value, older observation
  //    → close the old fact's validity and chain it. This is the temporal core.
  await cypher(
    `UNWIND $facts AS f
     MATCH (new:Fact {id: f.id})
     MATCH (old:Fact {status: 'active'})
     WHERE old.subject = new.subject
       AND old.attribute = new.attribute
       AND old.value <> new.value
       AND old.observed_at < new.observed_at
     SET old.status = 'superseded', old.valid_to = new.observed_at
     MERGE (new)-[:SUPERSEDES]->(old)`,
    { facts },
  );

  return facts;
}

/** Ingest a full ordered history (e.g. one LongMemEval instance's haystack). */
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
