/**
 * Connectivity check: round-trips a write through the configured store.
 * "A listening port is not proof the node works; a round-tripped write is."
 * Run this FIRST after starting a backing service.
 *
 * Store-agnostic now: it exercises the MemoryStore contract rather than any
 * one engine's Cypher, so it works against HydraDB, Neo4j, or the in-memory
 * store without changes. For a full check of an adapter, run
 * `hymem conformance`, which is this probe's exhaustive sibling.
 */
import { storeFromEnv } from "./env.js";
import { factId } from "./core/ids.js";

const store = await storeFromEnv();
const storeName = process.env.MEM_STORE ?? "hydradb";
const observedAt = new Date().toISOString();
const probeId = factId("probe", "bootstrap", observedAt);

try {
  await store.putSession({ id: "bootstrap", ts: observedAt, idx: 0 });
  await store.putFacts([
    {
      id: probeId,
      subject: "probe",
      attribute: "bootstrap",
      value: observedAt,
      text: "bootstrap probe",
      entities: ["probe"],
      observedAt,
      sessionId: "bootstrap",
      status: "active",
      validFrom: observedAt,
      validTo: null,
    },
  ]);
  await store.linkEntities([{ factId: probeId, entity: "probe" }]);

  const [readBack] = await store.search({ entities: ["probe"], limit: 1 });
  if (readBack?.value !== observedAt) {
    throw new Error(`probe read back ${JSON.stringify(readBack)}, expected value=${observedAt}`);
  }
  console.log(`${storeName} round-trip OK — probe value = ${readBack.value}`);
  await store.deleteFacts([probeId]);
} catch (error) {
  console.error(`${storeName} round-trip FAILED.`);
  console.error(
    "Checklist: service running? RUST_MIN_STACK=33554432 set (HydraDB)? " +
      "HYDRA_TOKEN matches the node's auth-token file? MEM_STORE pointing at the right engine?",
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  await store.close();
}
