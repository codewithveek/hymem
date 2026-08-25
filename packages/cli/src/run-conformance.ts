#!/usr/bin/env node
/**
 * `npm run conformance [store]` — verify a store adapter against the suite.
 * Defaults to the in-memory reference store, which needs no services running.
 */
import { runStoreConformance, CONFORMANCE_TEST_COUNT } from "@hymem/core/testing";
import { memoryStore, type MemoryStore } from "@hymem/core";
import { hydradb, neo4jStore } from "@hymem/bolt";
import { postgres } from "@hymem/postgres";
import { sqlite } from "@hymem/sqlite";
import { tidb } from "@hymem/tidb";
import { d1 } from "@hymem/d1";
import { DatabaseSync } from "node:sqlite";

try {
  process.loadEnvFile(".env"); // only the store adapters need credentials
} catch {
  /* no .env file — env vars may come from the shell, CI, or Docker */
}

// A live-service store is built once and reused; each test clears it first.
let sharedHydra: MemoryStore | undefined;
let sharedNeo4j: MemoryStore | undefined;
let sharedTidb: MemoryStore | undefined;
let sharedD1: MemoryStore | undefined;
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
  // Miniflare provides a real local D1 binding, so the 100-parameter cap and
  // the absence of interactive transactions are exercised for real.
  d1: async () => {
    if (!sharedD1) {
      const { Miniflare } = await import("miniflare");
      const miniflare = new Miniflare({
        workers: [
          {
            name: "hymem-d1-conformance",
            modules: true,
            compatibilityDate: "2026-01-01",
            script: "export default { fetch() { return new Response('ok'); } };",
            d1Databases: { DB: ":memory:" },
          },
        ],
      });
      const database = await miniflare.getD1Database("DB");
      sharedD1 = d1({ database: database as never, migrate: "auto" });
    }
    return sharedD1;
  },
  // TiDB exercises the MySQL dialect: no RETURNING, no data-modifying CTE,
  // ON DUPLICATE KEY UPDATE, and INSERT IGNORE as a statement prefix.
  tidb: async () => {
    if (!sharedTidb) {
      const mysql2 = await import("mysql2/promise");
      const pool = mysql2.createPool(
        process.env.TIDB_URL ?? "mysql://root@127.0.0.1:4000/test",
      );
      sharedTidb = tidb({ client: pool as never, migrate: "auto" });
    }
    return sharedTidb;
  },
  // Neo4j exercises the transactional supersede path that HydraDB cannot offer.
  neo4j: () =>
    (sharedNeo4j ??= neo4jStore({
      url: process.env.NEO4J_URL ?? "bolt://127.0.0.1:7688",
      user: process.env.NEO4J_USER ?? "neo4j",
      password: process.env.NEO4J_PASSWORD ?? "hymempass",
    })),
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
await sharedNeo4j?.close();
await sharedTidb?.close();
await sharedD1?.close();
await sharedPostgres?.close();
process.exit(result.failed.length === 0 ? 0 : 1);
