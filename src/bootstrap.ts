/**
 * Connectivity check: round-trips a write through the HydraDB node.
 * "A listening port is not proof the node works; a round-tripped write is."
 * Run this FIRST after starting graph-node (scripts/run-hydra.sh or docker compose).
 *
 * Uses the exact statement shapes the rest of the project relies on
 * (see the dialect note in src/hydra.ts): UNWIND-MERGE-SET node upsert,
 * MATCH ... RETURN, MATCH ... DETACH DELETE — all with integer ids.
 */
import { cypher, closeHydra, nodeId, upsertNodes } from "./hydra.js";

const id = nodeId("probe:bootstrap");

try {
  const ts = new Date().toISOString();
  await upsertNodes("Probe", [{ id, props: { key: "bootstrap", ts } }]);
  const rows = await cypher<{ ts: string }>(`MATCH (p:Probe {id: $id}) RETURN p.ts AS ts`, { id });
  if (rows[0]?.ts !== ts) throw new Error(`probe read back ${JSON.stringify(rows)}, expected ts=${ts}`);
  console.log(`HydraDB round-trip OK — probe.ts = ${rows[0].ts}`);
  await cypher(`MATCH (p:Probe {id: $id}) DETACH DELETE p`, { id });
} catch (e) {
  console.error("HydraDB round-trip FAILED.");
  console.error("Checklist: node running? RUST_MIN_STACK=33554432 set? HYDRA_TOKEN matches the node's auth-token file? Bolt auth scheme (see src/hydra.ts note)?");
  console.error(e);
  process.exitCode = 1;
} finally {
  await closeHydra();
}
