/**
 * The ports. Everything pluggable in hymem is one of these four interfaces.
 *
 * MemoryStore is the important one: it speaks *facts*, not nodes or rows, so
 * the ingest and recall algorithms in this package never learn what engine is
 * underneath. An adapter is ~9 methods; see `runStoreConformance` in
 * src/testing/conformance.ts for the executable definition of correct.
 */
import type {
  Fact, FactKey, QueryLink, SearchQuery, SessionInput, SessionRecord, StoredFact,
} from "./types.js";

export interface StoreCapabilities {
  /** Store can rank by embedding similarity. Recall falls back to entity anchoring when false. */
  vectorSearch: boolean;
  /** Store can apply the supersession trio (find → close → link) atomically. */
  transactions: boolean;
}

/**
 * Persistence port.
 *
 * Contract notes that adapters get wrong if they aren't spelled out:
 *
 *  - `putFacts` is an UPSERT keyed on `fact.id`. Re-stating a fact that was
 *    previously superseded must RE-ACTIVATE it: status back to "active",
 *    validFrom refreshed to the new observedAt, and validTo cleared to null.
 *    Ingesting the same history twice must be a no-op.
 *  - Ordering is always by `observedAt` ASCENDING in returned arrays.
 *  - `search` returns the MOST RECENT `limit` matches, but ordered ascending.
 *    (Take the newest N, then sort ascending — not the first N.)
 *  - String ids are the domain's identity. An engine needing another id shape
 *    (HydraDB wants non-negative integers) maps internally and keeps the
 *    string retrievable.
 */
export interface MemoryStore {
  readonly capabilities: StoreCapabilities;

  // --- write path -----------------------------------------------------------

  /** Upsert a session and, when `prevId` is given, the timeline edge prev → s. */
  putSession(s: SessionRecord, prevId?: string): Promise<void>;

  /** Upsert facts as active (see re-activation note above). */
  putFacts(facts: StoredFact[]): Promise<void>;

  /** Idempotently associate facts with canonical entity names. */
  linkEntities(links: { factId: string; entity: string }[]): Promise<void>;

  /**
   * Ids of currently-active facts that the incoming fact overwrites: same
   * subject + attribute, DIFFERENT value, and `observedAt < before`.
   * Must exclude the incoming fact's own id.
   */
  findSupersedable(key: FactKey & { before: string; excludeId: string }): Promise<string[]>;

  /** Mark facts superseded and stamp their validTo. */
  closeFacts(ids: string[], validTo: string): Promise<void>;

  /** Record that `newId` overwrote each of `oldIds`. Idempotent. */
  linkSupersedes(newId: string, oldIds: string[]): Promise<void>;

  // --- read path ------------------------------------------------------------

  /** Facts about ANY listed entity, optionally filtered to ANY listed attribute. */
  search(q: SearchQuery): Promise<StoredFact[]>;

  /** Values `factId` overwrote. Order is not significant; recall re-sorts. */
  getSupersededBy(factId: string): Promise<{ value: string; observedAt: string }[]>;

  // --- administration -------------------------------------------------------

  /** Every stored fact, optionally narrowed to one entity. Ascending by observedAt. */
  listFacts(entity?: string): Promise<StoredFact[]>;

  /** Delete facts and any edges touching them. Unknown ids are ignored. */
  deleteFacts(ids: string[]): Promise<void>;

  /** Remove everything this store owns. */
  clear(): Promise<void>;

  /** Release connections. Safe to call twice. */
  close(): Promise<void>;
}

/** Session transcript → durable facts. The write-path brain. */
export interface Extractor {
  extract(session: SessionInput): Promise<Fact[]>;
}

/** Question → store lookup keys. The read-path brain. */
export interface QueryPlanner {
  plan(question: string): Promise<QueryLink>;
}

/**
 * Question + retrieved context → prose. Optional: a memory constructed
 * without one still supports `recall()`, which is what agent authors
 * typically want (they inject `contextBlock` into their own prompt).
 */
export interface Answerer {
  answer(question: string, context: string): Promise<string>;
}
