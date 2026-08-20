/**
 * Connectivity check: round-trips a write through the HydraDB node.
 * "A listening port is not proof the node works; a round-tripped write is."
 * Run this FIRST after starting graph-node (scripts/run-hydra.sh).
 */
import { cypher, closeHydra } from "./hydra.js";

try {
  await cypher(`MERGE (p:Probe {id: 'bootstrap'}) SET p.ts = $ts`, { ts: new Date().toISOString() });
  const rows = await cypher<{ ts: string }>(`MATCH (p:Probe {id: 'bootstrap'}) RETURN p.ts AS ts`);
  console.log(`HydraDB round-trip OK — probe.ts = ${rows[0]?.ts}`);
  await cypher(`MATCH (p:Probe {id: 'bootstrap'}) DETACH DELETE p`);
} catch (e) {
  console.error("HydraDB round-trip FAILED.");
  console.error("Checklist: node running? RUST_MIN_STACK=33554432 exported? token matches? Bolt auth scheme (see src/hydra.ts note)?");
  console.error(e);
  process.exitCode = 1;
} finally {
  await closeHydra();
}
