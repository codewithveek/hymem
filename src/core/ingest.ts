import type { MemoryStore } from "./ports.js";
import type { Fact, SessionInput, StoredFact } from "./types.js";

/**
 * Ingest one session. Engine-agnostic: every persistence decision is a
 * MemoryStore call.
 *
 * The supersession pass is the subtle part. A fact is superseded when a LATER
 * session states a DIFFERENT value for the same (subject, attribute). We
 * resolve it after writing, so the incoming fact is already active and a
 * re-stated fact correctly closes whatever value was active in between.
 */
export async function ingestSession(
  store: MemoryStore,
  facts: Fact[],
  session: SessionInput,
  previousSessionId?: string,
): Promise<Fact[]> {
  await store.putSession({ id: session.id, ts: session.ts, idx: session.idx }, previousSessionId);
  if (facts.length === 0) return facts;

  const storedFacts: StoredFact[] = facts.map((fact) => ({
    ...fact,
    status: "active",
    validFrom: fact.observedAt,
    validTo: null, // clears any validTo left by an earlier supersession
  }));
  await store.putFacts(storedFacts);

  await store.linkEntities(
    facts.flatMap((fact) => fact.entities.map((entity) => ({ factId: fact.id, entity }))),
  );

  for (const incomingFact of facts) {
    const supersededIds = await store.findSupersedable({
      subject: incomingFact.subject,
      attribute: incomingFact.attribute,
      value: incomingFact.value,
      before: incomingFact.observedAt,
      excludeId: incomingFact.id,
    });
    if (supersededIds.length === 0) continue;
    await store.closeFacts(supersededIds, incomingFact.observedAt);
    await store.linkSupersedes(incomingFact.id, supersededIds);
  }
  return facts;
}

/** Ingest a whole history in chronological order, chaining the session timeline. */
export async function ingestHistory(
  store: MemoryStore,
  extract: (session: SessionInput) => Promise<Fact[]>,
  sessions: SessionInput[],
  onProgress?: (session: SessionInput, facts: Fact[]) => void,
): Promise<number> {
  const chronological = [...sessions].sort((earlier, later) => earlier.ts.localeCompare(later.ts));
  let totalFacts = 0;
  let previousSessionId: string | undefined;
  for (const session of chronological) {
    const facts = await ingestSession(store, await extract(session), session, previousSessionId);
    totalFacts += facts.length;
    previousSessionId = session.id;
    onProgress?.(session, facts);
  }
  return totalFacts;
}
