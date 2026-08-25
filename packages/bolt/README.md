# @hymem/bolt

Graph storage adapter for [hymem](https://github.com/codewithveek/hymem) over the Bolt protocol — HydraDB, Neo4j, and Memgraph.

```bash
npm install @hymem/core @hymem/bolt neo4j-driver
```

```ts
import { createMemory } from "@hymem/core";
import { hydradb } from "@hymem/bolt";

const memory = createMemory({
  store: hydradb({ url: "bolt://127.0.0.1:7687", token: process.env.HYDRA_TOKEN }),
  model,
  namespace: "org_42",
});
```

`neo4jStore()` and `memgraph()` are the other two factories. They are one
package rather than three because all three speak Bolt and share the same single
peer dependency — the reason SQL is split per engine is that `pg` and
better-sqlite3 are genuinely different installs.

## Caveats

`neo4j-driver` is pinned to `~5.27`. From 5.28 the JS driver uses the Bolt
manifest handshake, which HydraDB answers in several TCP writes and the driver
reads as one — a coin-flip connection failure. The driver retries around it as a
backstop if you bump the pin.

`atomicSupersede` differs by engine, because the engines differ:

| Factory | Supersession | `atomicSupersede` |
| --- | --- | --- |
| `neo4jStore()` | one managed write transaction (`executeWrite`) | **true** |
| `memgraph()` | one managed write transaction | **true** |
| `hydradb()` | separate round trips — no transaction in its Cypher subset | **false** |

Under `hydradb()`, two writers racing for the same `(subject, attribute)` slot
can both see it unclaimed and both stay active. Single-writer ingest is correct.
The conformance suite skips the concurrency test for it rather than letting it
pass by accident — and runs it for Neo4j, where it must pass.
