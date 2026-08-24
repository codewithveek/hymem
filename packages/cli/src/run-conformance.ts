#!/usr/bin/env node
/**
 * `npm run conformance [store]` — verify a store adapter against the suite.
 * Defaults to the in-memory reference store, which needs no services running.
 */
import { runStoreConformance, CONFORMANCE_TEST_COUNT } from "hymem/testing";
import { memoryStore, type MemoryStore } from "hymem";
import { hydradb } from "@hymem/bolt";
import { postgres } from "@hymem/postgres";
import { sqlite } from "@hymem/sqlite";
import { DatabaseSync } from "node:sqlite";

try {
  process.loadEnvFile(".env"); // only the store adapters need credentials
} catch {
  /* no .env file — env vars may come from the shell, CI, or Docker */
}

// A live-service store is built once and reused; each test clears it first.
let sharedHydra: MemoryStore | undefined;
let sharedSqlite: MemoryStore | undefined;
let sharedPostgres: MemoryStore | undefined;

const STORES: Record<string, () => MemoryStore | Promise<MemoryStore>> = {
  memory: memoryStore,
  // In-process SQLite via node:sqlite — no install, no service, real SQL.
  sqlite: () =>
    (sharedSqlite ??= sqlite({ database: new DatabaseSync(":memory:"), migrate: "auto" })),
  // Postgres over `pg`. PG_URL points at a throwaway database.
  postgres: async () => {
    if (!sharedPostgres) {
      const { Pool } = await import("pg");
      const pool = new Pool({
        connectionString: process.env.PG_URL ?? "postgres://postgres:hymem@127.0.0.1:55432/hymem",
      });
      sharedPostgres = postgres({ client: pool, migrate: "auto" });
    }
    return sharedPostgres;
  },
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
await sharedPostgres?.close();
process.exit(result.failed.length === 0 ? 0 : 1);
