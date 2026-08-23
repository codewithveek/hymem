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
}

/** A distilled triple-shaped fact, as produced by an Extractor. */
export interface Fact {
  /** Deterministic hash(subject|attribute|value) — re-stating a fact reuses this id. */
  id: string;
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
}

export interface SearchQuery {
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
