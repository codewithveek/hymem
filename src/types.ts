/** One chat session (LongMemEval haystack session, or a live agent session). */
export interface SessionInput {
  id: string;
  /** ISO-8601; drives chronology and supersession ordering. */
  ts: string;
  /** Zero-based position in the history. */
  idx: number;
  turns: { role: "user" | "assistant"; content: string }[];
}

/** A distilled triple-shaped fact. */
export interface Fact {
  id: string; // deterministic hash(subject|attribute|value)
  subject: string; // canonical entity the fact is about, e.g. "user"
  attribute: string; // snake_case slot, e.g. "home_city"
  value: string;
  text: string; // natural-language statement, used in the answer prompt
  entities: string[]; // canonical entity names mentioned
  observedAt: string; // ISO ts of the session it was stated in
  sessionId: string;
}

export interface RetrievedFact extends Fact {
  status: "active" | "superseded";
  validFrom: string;
  validTo: string | null;
  /** Older values this fact overwrote, newest first. */
  supersedes: { value: string; observedAt: string }[];
}

export interface RecallResult {
  facts: RetrievedFact[];
  abstained: boolean;
  /** Prompt-ready, chronologically ordered context block. */
  contextBlock: string;
}
