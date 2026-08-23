import { canonAttribute, canonEntity } from "./ids.js";
import type { MemoryStore } from "./ports.js";
import type { QueryLink, RecallResult, RetrievedFact, StoredFact } from "./types.js";

export interface RecallOptions {
  maxFacts: number;
  abstainThreshold: number;
}

/**
 * Temporal filtering happens here rather than in the store: every engine can
 * do string comparisons on ISO timestamps in memory, and pushing it down
 * would make the store contract markedly harder to implement correctly.
 */
function isWithinRequestedWindow(fact: StoredFact, link: QueryLink): boolean {
  if (link.temporal === "history") return true;
  if (link.temporal === "point_in_time" && link.at) {
    return fact.validFrom <= link.at && (fact.validTo === null || link.at < fact.validTo);
  }
  return fact.status === "active";
}

export async function recall(
  store: MemoryStore,
  link: QueryLink,
  options: RecallOptions,
): Promise<RecallResult> {
  const entities = [...new Set(link.entities.map(canonEntity))].filter(Boolean);
  const attributes = [...new Set((link.attributes ?? []).map(canonAttribute))].filter(Boolean);
  const limit = Math.max(1, Math.floor(options.maxFacts));

  const candidates = entities.length === 0 ? [] : await store.search({ entities, attributes, limit });
  const withinWindow = candidates
    .filter((candidate) => isWithinRequestedWindow(candidate, link))
    .slice(0, limit);

  const facts: RetrievedFact[] = await Promise.all(
    withinWindow.map(async (fact) => ({
      ...fact,
      supersedes: (await store.getSupersededBy(fact.id)).sort((newer, older) =>
        older.observedAt.localeCompare(newer.observedAt),
      ),
    })),
  );

  return {
    facts,
    abstained: facts.length < options.abstainThreshold,
    contextBlock: formatContext(facts),
    link,
  };
}

/**
 * Prompt-ready rendering. Supersession is annotated inline so the answerer can
 * reason about change rather than just about the latest value.
 */
export function formatContext(facts: RetrievedFact[]): string {
  return facts
    .map((fact) => {
      const history = fact.supersedes.length
        ? ` (previously: ${fact.supersedes
            .map((previous) => `"${previous.value}" until ${fact.observedAt}`)
            .join("; ")})`
        : "";
      const supersededFlag = fact.status === "superseded" ? " [SUPERSEDED — no longer current]" : "";
      return `- [${fact.observedAt} · session ${fact.sessionId}] ${fact.text}${history}${supersededFlag}`;
    })
    .join("\n");
}
