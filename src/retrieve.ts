import { z } from "zod";
import { config } from "./config.js";
import { cypher } from "./hydra.js";
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

export async function recall(question: string): Promise<RecallResult> {
  const link = await object(QueryLinkSchema, LINK_SYSTEM, question);
  const entities = link.entities.map(canonEntity);

  // Anchored traversal. Superseded facts are included when the question is
  // historical; otherwise validity filtering happens below.
  const rows = await cypher<{
    id: string; subject: string; attribute: string; value: string; text: string;
    observed_at: string; valid_from: string; valid_to: string | null; status: string;
    session_id: string; session_ts: string;
    old_values: { value: string; observed_at: string }[];
  }>(
    `MATCH (f:Fact)-[:ABOUT]->(e:Entity)
     WHERE e.name IN $entities
       AND (size($attrs) = 0 OR f.attribute IN $attrs)
     OPTIONAL MATCH (f)-[:SUPERSEDES]->(old:Fact)
     OPTIONAL MATCH (f)-[:STATED_IN]->(s:Session)
     RETURN DISTINCT f.id AS id, f.subject AS subject, f.attribute AS attribute,
            f.value AS value, f.text AS text, f.observed_at AS observed_at,
            f.valid_from AS valid_from, f.valid_to AS valid_to, f.status AS status,
            s.id AS session_id, s.ts AS session_ts,
            collect({value: old.value, observed_at: old.observed_at}) AS old_values
     ORDER BY observed_at
     LIMIT ${Math.max(1, Math.floor(config.maxFacts))}`,
    { entities, attrs: link.attributes ?? [] },
  );

  // Temporal filtering in TS keeps the Cypher within the supported subset.
  const facts: RetrievedFact[] = rows
    .filter((r) => {
      if (link.temporal === "history") return true; // superseded values are the point
      if (link.temporal === "point_in_time" && link.at) {
        return r.valid_from <= link.at && (r.valid_to === null || link.at < r.valid_to);
      }
      return r.status === "active"; // current-state default
    })
    .map((r) => ({
      id: r.id, subject: r.subject, attribute: r.attribute, value: r.value, text: r.text,
      entities: [], observedAt: r.observed_at, sessionId: r.session_id,
      status: r.status as "active" | "superseded",
      validFrom: r.valid_from, validTo: r.valid_to,
      supersedes: (r.old_values ?? []).filter((o) => o && o.value != null)
        .map((o) => ({ value: o.value, observedAt: o.observed_at }))
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt)),
    }));

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
