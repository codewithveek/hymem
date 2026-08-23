/**
 * In-memory reference store. Zero dependencies.
 *
 * Doubles as (a) the executable specification every other adapter is checked
 * against by runStoreConformance, and (b) the store you want in tests and
 * examples so nobody needs a database running to try hymem.
 */
import type { MemoryStore, StoreCapabilities } from "../core/ports.js";
import type { FactKey, SearchQuery, SessionRecord, StoredFact } from "../core/types.js";

const byObservedAtAscending = (earlier: StoredFact, later: StoredFact) =>
  earlier.observedAt.localeCompare(later.observedAt);

export function memoryStore(): MemoryStore {
  const factsById = new Map<string, StoredFact>();
  const sessionsById = new Map<string, SessionRecord & { previousSessionId?: string }>();
  /** entity name -> ids of facts mentioning it */
  const factIdsByEntity = new Map<string, Set<string>>();
  /** fact id -> ids of the facts it superseded */
  const supersededIdsByFactId = new Map<string, Set<string>>();

  const capabilities: StoreCapabilities = { vectorSearch: false, transactions: true };

  return {
    capabilities,

    async putSession(session: SessionRecord, previousSessionId?: string) {
      sessionsById.set(session.id, { ...session, previousSessionId });
    },

    async putFacts(incomingFacts: StoredFact[]) {
      for (const incomingFact of incomingFacts) {
        // Upsert semantics: a re-stated fact re-activates in place, and any
        // validTo left over from an earlier supersession is cleared.
        factsById.set(incomingFact.id, {
          ...incomingFact,
          status: "active",
          validFrom: incomingFact.observedAt,
          validTo: null,
        });
      }
    },

    async linkEntities(links) {
      for (const { factId, entity } of links) {
        let factIds = factIdsByEntity.get(entity);
        if (!factIds) factIdsByEntity.set(entity, (factIds = new Set()));
        factIds.add(factId);
      }
    },

    async findSupersedable(key: FactKey & { before: string; excludeId: string }) {
      return [...factsById.values()]
        .filter(
          (storedFact) =>
            storedFact.status === "active" &&
            storedFact.id !== key.excludeId &&
            storedFact.subject === key.subject &&
            storedFact.attribute === key.attribute &&
            storedFact.value !== key.value &&
            storedFact.observedAt < key.before,
        )
        .map((storedFact) => storedFact.id);
    },

    async closeFacts(factIds: string[], validTo: string) {
      for (const factId of factIds) {
        const storedFact = factsById.get(factId);
        if (storedFact) factsById.set(factId, { ...storedFact, status: "superseded", validTo });
      }
    },

    async linkSupersedes(newFactId: string, supersededFactIds: string[]) {
      let recorded = supersededIdsByFactId.get(newFactId);
      if (!recorded) supersededIdsByFactId.set(newFactId, (recorded = new Set()));
      for (const supersededId of supersededFactIds) recorded.add(supersededId);
    },

    async search(query: SearchQuery) {
      const matchedFactIds = new Set<string>();
      for (const entity of query.entities) {
        for (const factId of factIdsByEntity.get(entity) ?? []) matchedFactIds.add(factId);
      }
      const attributeFilter = query.attributes?.length ? new Set(query.attributes) : null;

      const matches = [...matchedFactIds]
        .map((factId) => factsById.get(factId))
        .filter(
          (storedFact): storedFact is StoredFact =>
            !!storedFact && (!attributeFilter || attributeFilter.has(storedFact.attribute)),
        )
        .sort(byObservedAtAscending);

      // Newest `limit`, handed back oldest-first.
      return matches.slice(Math.max(0, matches.length - query.limit));
    },

    async getSupersededBy(factId: string) {
      return [...(supersededIdsByFactId.get(factId) ?? [])]
        .map((supersededId) => factsById.get(supersededId))
        .filter((storedFact): storedFact is StoredFact => !!storedFact)
        .map((storedFact) => ({ value: storedFact.value, observedAt: storedFact.observedAt }));
    },

    async listFacts(entity?: string) {
      const pool = entity
        ? [...(factIdsByEntity.get(entity) ?? [])]
            .map((factId) => factsById.get(factId))
            .filter((storedFact): storedFact is StoredFact => !!storedFact)
        : [...factsById.values()];
      return pool.sort(byObservedAtAscending);
    },

    async deleteFacts(factIds: string[]) {
      for (const factId of factIds) {
        factsById.delete(factId);
        supersededIdsByFactId.delete(factId);
        for (const entityFactIds of factIdsByEntity.values()) entityFactIds.delete(factId);
        for (const supersededIds of supersededIdsByFactId.values()) supersededIds.delete(factId);
      }
    },

    async clear() {
      factsById.clear();
      sessionsById.clear();
      factIdsByEntity.clear();
      supersededIdsByFactId.clear();
    },

    async close() {},
  };
}
