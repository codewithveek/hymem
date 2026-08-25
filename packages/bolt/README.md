# @hymem/bolt

Graph storage for [hymem](https://github.com/codewithveek/hymem) over the Bolt protocol — **Neo4j**, **Memgraph**, and **HydraDB**.

Temporal, multi-tenant memory for AI agents, stored as a property graph:

```
(:Fact)-[:ABOUT]->(:Entity)
(:Fact)-[:STATED_IN]->(:Session)
(:Fact)-[:SUPERSEDES]->(:Fact)
(:Session)-[:NEXT]->(:Session)
```

One package rather than three, because all three engines speak Bolt and share the same single peer dependency. (The reason SQL is split per engine is that `pg` and better-sqlite3 are genuinely different installs; here there is nothing to separate.)

## Install

```bash
npm install @hymem/core @hymem/bolt neo4j-driver
```

## Usage

```ts
import { createMemory } from "@hymem/core";
import { neo4jStore } from "@hymem/bolt";
import { openai } from "@ai-sdk/openai";

const memory = createMemory({
  store: neo4jStore({
    url: "bolt://127.0.0.1:7687",
    user: "neo4j",
    password: process.env.NEO4J_PASSWORD,
  }),
  model: openai("gpt-4o-mini"),
  namespace: `usr_${userId}`,
});

await memory.remember(session);
const { contextBlock, abstained } = await memory.recall("where do I live?");
```

| Factory | Engine | Default URL |
| --- | --- | --- |
| `neo4jStore()` | Neo4j 5.x | `neo4j://127.0.0.1:7687` |
| `memgraph()` | Memgraph | `bolt://127.0.0.1:7687` |
| `hydradb()` | HydraDB | `neo4j://127.0.0.1:7687` |

Authentication is bearer-token by default (`token`); pass `user` and `password` for basic auth. Pass `driver` to supply a pre-built `CypherDriver` instead of a URL.

## Atomicity differs by engine

| Factory | Supersession | `atomicSupersede` |
| --- | --- | --- |
| `neo4jStore()` | one managed write transaction (`executeWrite`) | **true** |
| `memgraph()` | one managed write transaction | **true** |
| `hydradb()` | separate round trips | **false** |

Under `hydradb()`, two writers racing for the same `(subject, attribute)` slot can both see it unclaimed and both stay active. Single-writer ingest is correct. The conformance suite skips the concurrency test for it rather than letting it pass by accident, and runs it for Neo4j where it must pass.

`executeWrite` also retries on the transient errors Neo4j raises under contention — which is exactly the case this exists to handle.

## Engines are dialects, not adapters

All three share one store implementation. What differs is captured in a `Dialect`:

| | HydraDB | Neo4j / Memgraph |
| --- | --- | --- |
| Node ids | non-negative integers, sent as Bolt INTs | strings |
| `IN` predicates | unsupported — filters become `OR` chains | supported |
| `null` properties | unsupported — clearing means `REMOVE` | supported |

Adding another Cypher engine (Apache AGE, for instance) is a dialect entry rather than a new adapter.

## HydraDB notes

[HydraDB](https://github.com/hydra-db/hydradb) executes a deliberate **subset** of OpenCypher, and every statement here is written inside it. The rules that bite:

- Node and relationship ids are non-negative integers and must arrive as Bolt INTs — a plain JS number packs as FLOAT and is rejected.
- Node creation only via `UNWIND … MERGE … SET`; a standalone `MERGE` accepts only relationship paths.
- `MATCH` may be followed only by `SET` / `REMOVE` / `DELETE` — never `MERGE` or `CREATE`.
- No `IN`, `CONTAINS`, `IS NULL`, or `coalesce()`. Missing properties read back as `null`.
- A node-only `MATCH` needs a label, id, or property predicate.

The integer-id mapping is private to this adapter — the rest of hymem only ever sees a fact's string hash.

`neo4j-driver` is pinned to `~5.27`. From 5.28 the JS driver uses the Bolt manifest handshake, which HydraDB answers in several TCP writes and the driver reads as one — a coin-flip connection failure. The driver retries around it as a backstop if you bump the pin.

Run the node with `RUST_MIN_STACK=33554432`; without it, it serves health checks and then aborts on the first query.

HydraDB is AGPL-3.0 and is used unmodified as an external server over Bolt — it is neither linked nor bundled by this package.

## License

Apache-2.0.
