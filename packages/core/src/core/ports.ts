/**
 * The ports. Everything pluggable in hymem is one of these four interfaces.
 *
 * MemoryStore is the important one: it speaks *facts*, not nodes or rows, so
 * the ingest and recall algorithms in this package never learn what engine is
 * underneath. An adapter is ten methods; see `runStoreConformance` in
 * src/testing/conformance.ts for the executable definition of correct.
 */
import type {
  Fact, QueryLink, SearchQuery, SessionInput, SessionRecord, StoredFact,
} from "./types.js";

export interface StoreCapabilities {
  /** Store can rank by embedding similarity. Recall falls back to entity anchoring when false. */
  vectorSearch: boolean;
  /**
   * `supersede()` is atomic — concurrent writers cannot both observe the slot
   * as unclaimed and leave two active facts behind. False means best-effort:
   * correct single-writer, racy across processes.
   */
  atomicSupersede: boolean;
}

/**
 * Persistence port.
 *
 * TENANCY. Every operation is scoped to a `namespace`, and a store MUST NOT
 * return or modify anything outside the one it was given. The namespace is
 * passed per call rather than baked into the store on purpose: one store — and
 * so one connection pool — serves every tenant. A store per tenant would defeat
 * the point.
 *
 * Fact ids already embed the namespace, so an id cannot address another
 * tenant's row. Filter on the namespace column anyway: it is the index the
 * database wants, and defence in depth is cheap here.
 *
 * Contract notes that adapters get wrong if they aren't spelled out:
 *
 *  - `putFacts` is an UPSERT keyed on `fact.id`. Re-stating a fact that was
 *    previously superseded must RE-ACTIVATE it: status back to "active",
 *    validFrom refreshed to the new observedAt, and validTo cleared to null.
 *    Ingesting the same history twice must be a no-op.
 *  - Ordering is always by `observedAt` ASCENDING in returned arrays.
 *  - `search` returns the MOST RECENT `limit` matches, but ordered ascending.
 *    (Take the newest N, then sort ascending — not the first N.) `limit` is
 *    an upper bound and nothing more, so a limit of zero returns nothing.
 *  - String ids are the domain's identity. An engine needing another id shape
 *    (HydraDB wants non-negative integers) maps internally and keeps the
 *    string retrievable.
 */
export interface MemoryStore {
  readonly capabilities: StoreCapabilities;

  // --- write path -----------------------------------------------------------

  /** Upsert a session and, when `prevId` is given, the timeline edge prev → s. */
  putSession(namespace: string, session: SessionRecord, prevId?: string): Promise<void>;

  /** Upsert facts as active (see re-activation note above). */
  putFacts(facts: StoredFact[]): Promise<void>;

  /**
   * Idempotently associate facts with canonical entity names.
   *
   * A `factId` this namespace does not own is IGNORED, exactly as `deleteFacts`
   * ignores one. The link table is what `search` anchors on, so accepting a
   * foreign id would let one tenant change what another tenant's own queries
   * return — a write outside the namespace, by a different door.
   */
  linkEntities(namespace: string, links: { factId: string; entity: string }[]): Promise<void>;

  /**
   * Close every active fact that `incoming` overwrites, record the
   * supersession, and return the closed ids.
   *
   * A fact is overwritten when it shares `subject` + `attribute`, holds a
   * DIFFERENT `value`, and was observed strictly before `incoming.observedAt`.
   * The incoming fact's own id is never a candidate. Closing means status
   * `superseded` and `validTo = incoming.observedAt`. Idempotent: running it
   * twice closes nothing new and records no duplicate links.
   *
   * This is ONE method rather than find → close → link on purpose. Those three
   * steps carry an invariant no caller-sequenced version can hold: between the
   * find and the close, another writer can claim the same slot, and both end up
   * active. Keeping it inside the port lets an engine enforce it — a
   * data-modifying CTE, `SELECT ... FOR UPDATE`, a transaction — and lets
   * `capabilities.atomicSupersede` be a claim the store can actually make.
   */
  supersede(incoming: StoredFact): Promise<string[]>;

  // --- read path ------------------------------------------------------------

  /** Facts about ANY listed entity, optionally filtered to ANY listed attribute. */
  search(q: SearchQuery): Promise<StoredFact[]>;

  /** Values `factId` overwrote. Order is not significant; recall re-sorts. */
  getSupersededBy(namespace: string, factId: string): Promise<{ value: string; observedAt: string }[]>;

  // --- administration -------------------------------------------------------

  /** Every stored fact in the namespace, optionally narrowed to one entity. Ascending by observedAt. */
  listFacts(namespace: string, entity?: string): Promise<StoredFact[]>;

  /** Delete facts and any edges touching them. Unknown ids are ignored. */
  deleteFacts(namespace: string, ids: string[]): Promise<void>;

  /**
   * Remove everything in ONE namespace. There is deliberately no "wipe the
   * whole store" call: dropping every tenant is a database administration task,
   * not something a memory instance should be able to do by accident.
   */
  clear(namespace: string): Promise<void>;

  /** Release connections. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * Session transcript → durable facts. The write-path brain.
 *
 * An extractor returns triples, NOT identity: core assigns `id` and `namespace`
 * and applies the speaker rewrite afterwards, so a custom extractor cannot get
 * hashing, canonicalisation, or tenancy wrong. Anything it puts in those two
 * fields is ignored.
 *
 * Attribute facts about the person speaking to the configured speaker token
 * ("user" by default) — core swaps that for the session's `speaker`.
 */
export interface Extractor {
  extract(session: SessionInput): Promise<ExtractedFact[]>;
}

/** An alternative name the speaker used for an entity — "my wife" for "sarah". */
export interface EntityAlias {
  /** How the speaker referred to them: "wife", "my manager", "bob". */
  alias: string;
  /** The canonical entity it refers to, as it appears in `entities`. */
  of: string;
}

/** What an extractor produces: a triple, with identity left to core. */
export type ExtractedFact = Omit<Fact, "id" | "namespace"> & {
  /**
   * Alternative names used for entities in this fact. Core turns each one into
   * an extra entity link, so a later question phrased with the alias still
   * reaches the fact. Optional — an extractor that emits none simply loses that
   * recall path.
   */
  aliases?: EntityAlias[];
};

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
