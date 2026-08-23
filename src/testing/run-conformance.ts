#!/usr/bin/env node
/**
 * `npm run conformance [store]` — verify a store adapter against the suite.
 * Defaults to the in-memory reference store, which needs no services running.
 */
import { runStoreConformance, CONFORMANCE_TEST_COUNT } from "./conformance.js";
import { memoryStore } from "../stores/memory-store.js";
import { hydradb } from "../stores/cypher/index.js";
import type { MemoryStore } from "../core/ports.js";

try {
  process.loadEnvFile(".env"); // only the store adapters need credentials
} catch {
  /* no .env file — env vars may come from the shell, CI, or Docker */
}

// A live-service store is built once and reused; each test clears it first.
let sharedHydra: MemoryStore | undefined;

const STORES: Record<string, () => MemoryStore | Promise<MemoryStore>> = {
  memory: memoryStore,
  hydradb: () =>
    (sharedHydra ??= hydradb({
      url: process.env.HYDRA_BOLT_URL ?? "neo4j://127.0.0.1:7687",
      token: process.env.HYDRA_TOKEN ?? "local-development-token-32-bytes",
    })),
};

const name = process.argv[2] ?? "memory";
const make = STORES[name];
if (!make) {
  console.error(`Unknown store "${name}". Available: ${Object.keys(STORES).join(", ")}`);
  process.exit(1);
}

console.log(`Running ${CONFORMANCE_TEST_COUNT} conformance tests against "${name}":\n`);
const result = await runStoreConformance(make, { verbose: true });
console.log(
  `\n${result.passed} passed, ${result.failed.length} failed, ${result.skipped.length} skipped`,
);
await sharedHydra?.close();
process.exit(result.failed.length === 0 ? 0 : 1);
