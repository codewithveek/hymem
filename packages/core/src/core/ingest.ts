import { canonEntity, DEFAULT_SPEAKER_TOKEN, factId } from "./ids.js";
import type { ExtractedFact, MemoryStore } from "./ports.js";
import type { Fact, SessionInput, StoredFact } from "./types.js";

export interface IngestOptions {
  namespace: string;
  /** Placeholder the extractor uses for "the human speaking". Default "user". */
  speakerToken?: string;
}

/**
 * Turn extractor output into identified, namespaced facts.
 *
 * Two things happen here rather than in the extractor, so that no custom
 * extractor can get them wrong:
 *
 *  1. The speaker rewrite. The extractor emits a fixed placeholder for the
 *     person speaking; we swap it for `session.speaker`. Identity comes from
 *     the caller's auth system, never from the model — a model asked to name
 *     the speaker returns "alice", "Alice", and "alice smith" across three
 *     sessions.
 *  2. Identity. `factId` hashes the namespace with the FINAL subject, so it can
 *     only be computed after the rewrite.
 *
 * With no `speaker` set the placeholder stays literal, which is correct when a
 * namespace holds one person: the namespace already is the identity.
 */
export function identifyFacts(
  extracted: ExtractedFact[],
  session: SessionInput,
  options: IngestOptions,
): Fact[] {
  const token = canonEntity(options.speakerToken ?? DEFAULT_SPEAKER_TOKEN);
  const speaker = session.speaker ? canonEntity(session.speaker) : undefined;
  const speakerName = session.speakerName ? canonEntity(session.speakerName) : undefined;

  /** Swap the placeholder for the speaker's real identity. */
  const resolve = (name: string): string => {
    const canonical = canonEntity(name);
    return speaker && canonical === token ? speaker : canonical;
  };

  return extracted.map((fact) => {
    const subject = resolve(fact.subject);
    const attribute = fact.attribute.trim().toLowerCase();
    const value = fact.value.trim();
    const entities = new Set(fact.entities.map(resolve));
    entities.add(subject);
    // Dual-link: facts keyed by an opaque speaker id stay reachable by name,
    // so "what did Bob decide?" resolves even though the subject is usr_7f3a91.
    if (speakerName && subject === speaker) entities.add(speakerName);

    return {
      ...fact,
      namespace: options.namespace,
      subject,
      attribute,
      value,
      entities: [...entities],
      id: factId(options.namespace, subject, attribute, value),
      observedAt: session.ts,
      sessionId: session.id,
    };
  });
}

/**
 * Ingest one session. Engine-agnostic: every persistence decision is a
 * MemoryStore call.
 *
 * The supersession pass is the subtle part. A fact is superseded when a LATER
 * session states a DIFFERENT value for the same (subject, attribute) inside the
 * same namespace. We resolve it after writing, so the incoming fact is already
 * active and a re-stated fact correctly closes whatever value was active in
 * between.
 */
export async function ingestSession(
  store: MemoryStore,
  facts: Fact[],
  session: SessionInput,
  options: IngestOptions,
  previousSessionId?: string,
): Promise<Fact[]> {
  const { namespace } = options;
  await store.putSession(
    namespace,
    { id: session.id, ts: session.ts, idx: session.idx, speaker: session.speaker },
    previousSessionId,
  );
  if (facts.length === 0) return facts;

  const storedFacts: StoredFact[] = facts.map((fact) => ({
    ...fact,
    status: "active",
    validFrom: fact.observedAt,
    validTo: null, // clears any validTo left by an earlier supersession
  }));
  await store.putFacts(storedFacts);

  await store.linkEntities(
    namespace,
    facts.flatMap((fact) => fact.entities.map((entity) => ({ factId: fact.id, entity }))),
  );

  // One call per fact: the store owns closing the old values and recording the
  // chain, so the window where two writers could both claim a slot stays
  // inside whatever atomicity the engine offers.
  for (const storedFact of storedFacts) {
    await store.supersede(storedFact);
  }
  return facts;
}

/** Ingest a whole history in chronological order, chaining the session timeline. */
export async function ingestHistory(
  store: MemoryStore,
  extract: (session: SessionInput) => Promise<Fact[]>,
  sessions: SessionInput[],
  options: IngestOptions,
  onProgress?: (session: SessionInput, facts: Fact[]) => void,
): Promise<number> {
  const chronological = [...sessions].sort((earlier, later) => earlier.ts.localeCompare(later.ts));
  let totalFacts = 0;
  let previousSessionId: string | undefined;
  for (const session of chronological) {
    const facts = await ingestSession(
      store,
      await extract(session),
      session,
      options,
      previousSessionId,
    );
    totalFacts += facts.length;
    previousSessionId = session.id;
    onProgress?.(session, facts);
  }
  return totalFacts;
}
