/**
 * Domain types. Engine-agnostic: nothing here knows about graphs, tables,
 * documents, or any particular driver.
 */

/** One chat session (LongMemEval haystack session, or a live agent session). */
export interface SessionInput {
  id: string;
  /** ISO-8601; drives chronology and supersession ordering. */
  ts: string;
  /** Zero-based position in the history. */
  idx: number;
  turns: { role: "user" | "assistant"; content: string }[];
  /**
   * Stable identity of the human in this transcript — whatever your auth
   * system already uses ("alice", "usr_7f3a91"). hymem never generates one.
   *
   * Facts the extractor attributes to the speaker are re-subjected to this
   * value. Needed only when several people share a namespace: with one person
   * per namespace the namespace already IS the identity, so leave it unset and
   * the speaker token stays literal.
   */
  speaker?: string;
  /**
   * Human-readable alias for `speaker`, linked alongside it as an entity so
   * name-based recall ("what did Bob decide?") still resolves to facts keyed
   * by an opaque id. Identity stays the id; this is only a lookup alias.
   */
  speakerName?: string;
}

/** A distilled triple-shaped fact, as produced by an Extractor. */
export interface Fact {
  /**
   * Deterministic hash(namespace|subject|attribute|value) — re-stating a fact
   * reuses this id. Assigned by core, not by the extractor: the speaker rewrite
   * happens first, so only core knows the final subject.
   */
  id: string;
  /** Tenant boundary. The same triple in two namespaces is two separate facts. */
  namespace: string;
  /** Canonical entity the fact is about, e.g. "user". */
  subject: string;
  /** snake_case slot, e.g. "home_city". Collisions on (subject, attribute) drive supersession. */
  attribute: string;
  value: string;
  /** Natural-language statement, used in the answer prompt. */
  text: string;
  /** Canonical entity names mentioned; always includes `subject`. */
  entities: string[];
  /** ISO ts of the session it was stated in. */
  observedAt: string;
  sessionId: string;
}

export type FactStatus = "active" | "superseded";

/** A fact plus the bitemporal state a MemoryStore persists for it. */
export interface StoredFact extends Fact {
  status: FactStatus;
  validFrom: string;
  validTo: string | null;
}

/** A stored fact plus the values it overwrote, newest first. */
export interface RetrievedFact extends StoredFact {
  supersedes: { value: string; observedAt: string }[];
}

export interface SessionRecord {
  id: string;
  ts: string;
  idx: number;
  speaker?: string;
}

export interface SearchQuery {
  /** Tenant boundary. Never match outside it. */
  namespace: string;
  /** Match facts about ANY of these canonical entity names. */
  entities: string[];
  /** If non-empty, additionally require the attribute to be ANY of these. */
  attributes?: string[];
  /** Return at most this many facts. */
  limit: number;
}

/** How a question should be resolved against the timeline. */
export type TemporalMode = "current" | "point_in_time" | "history";

/** A question mapped onto store lookup keys, as produced by a QueryPlanner. */
export interface QueryLink {
  entities: string[];
  attributes: string[];
  temporal: TemporalMode;
  /** ISO timestamp when temporal is "point_in_time", else null. */
  at: string | null;
}

export interface RecallResult {
  facts: RetrievedFact[];
  abstained: boolean;
  /** Prompt-ready, chronologically ordered context block. */
  contextBlock: string;
  /** The plan that produced this result — useful for debugging retrieval. */
  link: QueryLink;
}

export interface AnswerResult {
  answer: string;
  abstained: boolean;
  contextBlock: string;
}
