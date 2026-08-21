import { z } from "zod";
import { config } from "./config.js";
import { cypher } from "./hydra.js";
import { entityNodeId, factNodeId } from "./ids.js";
import { object } from "./llm.js";
import { canonEntity } from "./extract.js";
import type { RecallResult, RetrievedFact } from "./types.js";

const QueryLinkSchema = z.object({
  entities: z.array(z.string()).describe('Lowercase canonical entity names likely to appear; "user" almost always belongs here'),
  attributes: z.array(z.string()).describe("Likely snake_case fact slots (home_city, job_title, ...); empty = no filter"),
  temporal: z.enum(["current", "point_in_time", "history"]).describe(
    '"current" for present-state questions, "point_in_time" for as-of-a-date questions, "history" for before/after/change questions',
  ),
  at: z.string().nullable().describe('ISO timestamp when temporal is "point_in_time", else null'),
});

const LINK_SYSTEM = "You map a question about a user's chat history to graph lookup keys.";

/**
 * Reads stay inside HydraDB's Cypher subset (dialect note in src/hydra.ts):
 * one entity-anchored traversal per linked entity (anchor = integer entity id;
 * no IN, so attribute filters are OR-chains), merged in process. Provenance
 * (session_id) is a Fact property, and supersession history is fetched per
 * fact with a second small traversal instead of OPTIONAL MATCH + collect().
 */
interface FactRow {
  id: string; subject: string; attribute: string; value: string; text: string;
  observed_at: string; valid_from: string; valid_to: string | null; status: string;
  session_id: string;
}

export async function recall(question: string): Promise<RecallResult> {
  const link = await object(QueryLinkSchema, LINK_SYSTEM, question);
  const entities = [...new Set(link.entities.map(canonEntity))];
  const attrs = [...new Set(link.attributes ?? [])];
  const limit = Math.max(1, Math.floor(config.maxFacts));

  const attrFilter = attrs.length > 0 ? `WHERE ${attrs.map((_, i) => `f.attribute = $a${i}`).join(" OR ")}` : "";
  const attrParams = Object.fromEntries(attrs.map((a, i) => [`a${i}`, a]));

  const seen = new Set<string>();
  const rows: FactRow[] = [];
  for (const name of entities) {
    const part = await cypher<FactRow>(
      `MATCH (f:Fact)-[:ABOUT]->(e:Entity {id: $eid}) ${attrFilter}
       RETURN f.key AS id, f.subject AS subject, f.attribute AS attribute,
              f.value AS value, f.text AS text, f.observed_at AS observed_at,
              f.valid_from AS valid_from, f.valid_to AS valid_to, f.status AS status,
              f.session_id AS session_id
       ORDER BY observed_at
       LIMIT ${limit}`,
      { eid: entityNodeId(name), ...attrParams },
    );
    for (const r of part) {
      if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
    }
  }
  rows.sort((a, b) => a.observed_at.localeCompare(b.observed_at));

  const filtered = rows.filter((r) => {
    if (link.temporal === "history") return true;
    if (link.temporal === "point_in_time" && link.at) {
      return r.valid_from <= link.at && (r.valid_to === null || r.valid_to === undefined || link.at < r.valid_to);
    }
    return r.status === "active";
  }).slice(0, limit);

  const facts: RetrievedFact[] = [];
  for (const r of filtered) {
    const olds = await cypher<{ value: string; observed_at: string }>(
      `MATCH (f:Fact {id: $id})-[:SUPERSEDES]->(o:Fact)
       RETURN o.value AS value, o.observed_at AS observed_at`,
      { id: factNodeId(r.id) },
    );
    facts.push({
      id: r.id, subject: r.subject, attribute: r.attribute, value: r.value, text: r.text,
      entities: [], observedAt: r.observed_at, sessionId: r.session_id,
      status: r.status as "active" | "superseded",
      validFrom: r.valid_from, validTo: r.valid_to ?? null,
      supersedes: olds.sort((a, b) => b.observed_at.localeCompare(a.observed_at))
        .map((o) => ({ value: o.value, observedAt: o.observed_at })),
    });
  }

  const abstained = facts.length < config.abstainThreshold;

  const contextBlock = facts
    .map((f) => {
      const history = f.supersedes.length
        ? ` (previously: ${f.supersedes.map((o) => `"${o.value}" until ${f.observedAt}`).join("; ")})`
        : "";
      const flag = f.status === "superseded" ? " [SUPERSEDED — no longer current]" : "";
      return `- [${f.observedAt} · session ${f.sessionId}] ${f.text}${history}${flag}`;
    })
    .join("\n");

  return { facts, abstained, contextBlock };
}
