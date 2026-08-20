import neo4j, { Driver } from "neo4j-driver";
import { config } from "./config.js";

/**
 * HydraDB speaks Bolt 5.x, so the official Neo4j JS driver works.
 * Bolt gives us parameterized queries — essential for safe batched UNWIND writes.
 *
 * ADJUST ON FIRST RUN: the auth scheme HydraDB expects over Bolt.
 * The repo README shows a bearer token for HTTP; for Bolt try, in order:
 *   1) neo4j.auth.bearer(config.token)
 *   2) neo4j.auth.basic("", config.token)
 * scripts/runtime_smoke.sh in the HydraDB repo (Python driver) shows the
 * working combination — mirror whatever it does.
 */
let driver: Driver | null = null;

function getDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(config.boltUrl, neo4j.auth.bearer(config.token), {
      disableLosslessIntegers: true,
    });
  }
  return driver;
}

export async function cypher<T = Record<string, unknown>>(
  query: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const session = getDriver().session();
  try {
    const res = await session.run(query, params);
    return res.records.map((r) => Object.fromEntries(r.keys.map((k) => [k, r.get(k)])) as T);
  } finally {
    await session.close();
  }
}

/**
 * HTTP fallback (no parameters — the documented body is {cell_id, query}).
 * Use only for fixed queries or connectivity checks; never interpolate
 * untrusted strings into Cypher here.
 */
export async function cypherHttp(query: string, consistency: "causal" | "strong" = "causal"): Promise<unknown> {
  const res = await fetch(`${config.httpUrl}/v1/graphs/${config.graphId}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "X-Graph-Namespace": config.namespace,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ cell_id: config.cellId, query, consistency }),
  });
  if (!res.ok) throw new Error(`HydraDB HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function closeHydra(): Promise<void> {
  await driver?.close();
  driver = null;
}
