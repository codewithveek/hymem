import { aliasEntity, canonAttribute, canonEntity, DEFAULT_SPEAKER_TOKEN } from "./ids.js";
import type { MemoryStore } from "./ports.js";
import type { QueryLink, RecallResult, RetrievedFact, StoredFact } from "./types.js";

export interface RecallOptions {
  namespace: string;
  maxFacts: number;
  abstainThreshold: number;
  /**
   * Who "I"/"the user" refers to in this question. The planner emits the
   * speaker token; we swap it for this, mirroring the write path. Leave unset
   * when the namespace holds one person.
   */
  speaker?: string;
  /** Placeholder the planner uses for the speaker. Default "user". */
  speakerToken?: string;
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

/** How fast the candidate window widens, and how far it is allowed to go. */
const CANDIDATE_GROWTH = 4;
const MAX_CANDIDATE_FACTOR = 64;

/**
 * The store applies `limit` before recall can apply the time window, so asking
 * for exactly `limit` rows loses valid facts whenever the newest ones are
 * superseded or fall outside the window: they consume the budget and the older
 * facts that would have satisfied the question never leave the database.
 *
 * Rather than push temporal predicates into the store contract, widen the
 * candidate window and retry until enough facts survive the filter, the store
 * runs out of matches (fewer rows back than asked for), or the ceiling is hit.
 * Ordinary questions settle on the first pass; a namespace whose recent history
 * is almost entirely superseded pays a few extra round trips instead of
 * silently abstaining.
 */
async function gatherWithinWindow(
  store: MemoryStore,
  link: QueryLink,
  namespace: string,
  entities: string[],
  attributes: string[],
  limit: number,
): Promise<StoredFact[]> {
  const ceiling = limit * MAX_CANDIDATE_FACTOR;
  let requested = limit;
  for (;;) {
    const candidates = await store.search({ namespace, entities, attributes, limit: requested });
    const matching = candidates.filter((candidate) => isWithinRequestedWindow(candidate, link));
    const exhausted = candidates.length < requested;
    if (matching.length >= limit || exhausted || requested >= ceiling) {
      // Candidates arrive oldest-first; the newest are the ones recall wants.
      return matching.slice(Math.max(0, matching.length - limit));
    }
    requested = Math.min(requested * CANDIDATE_GROWTH, ceiling);
  }
}

export async function recall(
  store: MemoryStore,
  link: QueryLink,
  options: RecallOptions,
): Promise<RecallResult> {
  // Same substitution as ingest: the planner says "user", the store knows an
  // identity. Without this, a question about oneself finds nothing in a
  // namespace where facts are keyed by speaker id.
  const token = canonEntity(options.speakerToken ?? DEFAULT_SPEAKER_TOKEN);
  const speaker = options.speaker ? canonEntity(options.speaker) : undefined;
  const resolve = (name: string): string => {
    const canonical = canonEntity(name);
    return speaker && canonical === token ? speaker : canonical;
  };

  /**
   * Search the plain entity AND its alias forms.
   *
   * The planner cannot know whether "wife" is a stored entity or an alias for
   * one, so both are asked for. Matching is exact, so the extra names cost one
   * more term in an IN list and can never widen a result set to something
   * unrelated — an alias entity exists only where a session declared it.
   *
   * Both the speaker-scoped and bare forms are included: a namespace can hold
   * sessions written with a speaker and sessions written without one.
   */
  const expand = (name: string): string[] => {
    const canonical = resolve(name);
    const forms = [canonical, aliasEntity(canonical)];
    if (speaker) forms.push(aliasEntity(canonical, speaker));
    return forms;
  };

  const entities = [...new Set(link.entities.flatMap(expand))].filter(Boolean);
  const attributes = [...new Set((link.attributes ?? []).map(canonAttribute))].filter(Boolean);
  const limit = Math.max(1, Math.floor(options.maxFacts));

  const withinWindow =
    entities.length === 0
      ? []
      : await gatherWithinWindow(store, link, options.namespace, entities, attributes, limit);

  const facts: RetrievedFact[] = await Promise.all(
    withinWindow.map(async (fact) => ({
      ...fact,
      supersedes: (await store.getSupersededBy(options.namespace, fact.id)).sort((newer, older) =>
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
