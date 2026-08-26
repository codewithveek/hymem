# @hymem/core

**Temporal, multi-tenant memory for AI agents — with pluggable storage.**

Agents forget between sessions. A vector store gets you *similar* text, but it can't tell you the user moved to Denver in July and used to live in Atlanta, and it will happily invent an answer when it has nothing.

hymem stores memory as **facts with lifetimes**:

- **Bitemporal.** Every fact carries `validFrom` / `validTo`. A later contradiction *closes* the old value rather than deleting it, so "where do they live?" and "where did they live before?" both have real answers.
- **Structurally honest.** With no supporting facts, recall abstains *before* the model is asked.
- **Inspectable.** Every fact traces to its source session and can be listed or deleted individually. Aliases are ordinary entity links, so *"my wife"* resolves to `sarah` without a similarity index.
- **Multi-tenant.** Every fact is scoped to a required `namespace`.
- **Storage-agnostic.** One `MemoryStore` port; Postgres, SQLite, TiDB/MySQL, Cloudflare D1, Neo4j, Memgraph, HydraDB and in-memory are interchangeable.

This package holds the memory model, the ports, the in-memory store, the SQL and Cypher store *logic*, and the conformance suite. It depends on `zod` and nothing else — every database dependency lives in a separate adapter package.

## Install

```bash
npm install @hymem/core ai @ai-sdk/openai
```

Add a store when you outgrow the in-memory one:

```bash
npm install @hymem/sqlite      # or @hymem/postgres, @hymem/tidb, @hymem/d1, @hymem/bolt
```

## Quick start

```ts
import { createMemory, memoryStore } from "@hymem/core";
import { openai } from "@ai-sdk/openai";

const memory = createMemory({
  store: memoryStore(),
  model: openai("gpt-4o-mini"),
  namespace: "demo",              // required — the tenant boundary
});

await memory.rememberAll([
  {
    id: "s1", idx: 0, ts: "2026-03-01T10:00:00Z",
    turns: [{ role: "user", content: "I just moved to Atlanta for a job at Delta." }],
  },
  {
    id: "s2", idx: 1, ts: "2026-07-20T18:30:00Z",
    turns: [{ role: "user", content: "I relocated to Denver last week." }],
  },
]);

await memory.ask("Where do I live now?");        // "Denver, as of July 2026."
await memory.ask("Where did I live before?");    // "Atlanta, until July 2026."
await memory.ask("What's my shoe size?");        // abstains — never reaches the model
```

### Recall without an answer

Most agents want the facts, not prose:

```ts
const { facts, contextBlock, abstained } = await memory.recall("where do I live?");

if (!abstained) {
  messages.push({ role: "system", content: `What you know:\n${contextBlock}` });
}
```

`contextBlock` is prompt-ready and annotates superseded values inline:

```
- [2026-07-20T18:30:00Z · session s2] The user relocated to Denver.
    (previously: "Atlanta" until 2026-07-20T18:30:00Z)
```

## Multi-tenancy

`namespace` is required with no default — an accidentally shared namespace is a data leak, so it has to be a decision.

```ts
createMemory({ store, model, namespace: `usr_${userId}` })   // personal
createMemory({ store, model, namespace: `org_${orgId}` })    // shared team memory
```

A shared namespace also needs a **speaker**, or everyone collides: extraction canonicalises whoever is talking to `"user"`, so without an identity Alice and Bob produce the same fact id, and Bob moving would supersede Alice's home city.

```ts
await memory.remember({ ...session, speaker: "usr_alice" });
await memory.recall("where do I live?", { speaker: "usr_alice" });
```

`speaker` is an opaque string you supply — hymem never invents one. Pass `speakerName` alongside an opaque id so name-based questions ("what did Bob decide?") still resolve.

One person per namespace needs no speaker: the namespace is already the identity.

## API

### `createMemory(options)`

| Option | Type | Notes |
| --- | --- | --- |
| `store` | `MemoryStore` | **Required.** |
| `namespace` | `string` | **Required.** No default. |
| `model` | `LanguageModel` | Fills extractor, planner and answerer. |
| `speaker` | `string` | Default human identity. |
| `speakerToken` | `string` | Extractor placeholder. Default `"user"`. |
| `extractor` / `planner` / `answerer` | ports | Override individually; `answerer: null` = recall-only. |
| `maxFacts` | `number` | Default `24`. |
| `abstainThreshold` | `number` | Default `1`. |

### `Memory`

| Method | Returns |
| --- | --- |
| `remember(session, prevSessionId?)` | `Fact[]` |
| `rememberAll(sessions, onProgress?)` | `number` |
| `recall(question, { speaker }?)` | `{ facts, contextBlock, abstained, link }` |
| `ask(question, { speaker }?)` | `{ answer, contextBlock, abstained }` |
| `facts(entity?)` | `StoredFact[]` |
| `forget(ids)` / `clear()` / `close()` | — |

### Replacing a stage

```ts
createMemory({
  store: memoryStore(),
  namespace: "demo",
  extractor: myRulesExtractor,   // no LLM on the write path
  answerer: null,                // recall-only
});
```

The pure algorithms are exported and import nothing: `ingestSession`, `recall`, `formatContext`, `factId`, `canonEntity`.

## Entry points

| Import | Contents |
| --- | --- |
| `@hymem/core` | `createMemory`, `memoryStore`, algorithms, all types |
| `@hymem/core/stores/sql` | `sqlStore`, dialects, schema helpers, `SqlDriver` |
| `@hymem/core/stores/cypher` | `cypherStore`, dialects, `CypherDriver` |
| `@hymem/core/llm` | `llmExtractor`, `llmPlanner`, `llmAnswerer` |
| `@hymem/core/testing` | `runStoreConformance` |

## Writing a store adapter

Ten methods and a passing conformance run — 28 tests covering round-tripping, supersession, re-activation, idempotent re-ingest, ordering, limits, deletion, concurrency, and tenant isolation. No LLM, no API keys.

```ts
import { runStoreConformance } from "@hymem/core/testing";

const result = await runStoreConformance(() => myStore());
console.log(`${result.passed} passed, ${result.failed.length} failed`);
```

## Serverless

Core runs on edge runtimes. It reads no global unchecked and uses one Node builtin — `node:crypto` for `createHash`, which Cloudflare Workers supports synchronously under the `nodejs_compat` flag.

Pick an adapter that fits the runtime: [`@hymem/d1`](https://www.npmjs.com/package/@hymem/d1) on Workers, [`@hymem/tidb`](https://www.npmjs.com/package/@hymem/tidb) with the `fetch`-based TiDB Cloud driver anywhere, or `memoryStore()` for per-request scratch memory. `@hymem/sqlite` needs `node:sqlite` and will not run in a Worker.

## License

Apache-2.0. Full documentation: [github.com/codewithveek/hymem](https://github.com/codewithveek/hymem).
