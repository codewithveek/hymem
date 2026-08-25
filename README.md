# hymem

**Temporal, multi-tenant memory for AI agents — with pluggable storage.**

Agents forget between sessions. Bolting a vector store on gets you *similar* text, but it can't tell you that the user moved to Denver in July and used to live in Atlanta, and it will happily invent an answer when it has nothing.

hymem stores memory as **facts with lifetimes**, not embeddings:

- **Bitemporal.** Every fact carries `validFrom` / `validTo`. When a later session contradicts an earlier one about the same `(subject, attribute)`, the old value is *closed*, not deleted — so "where do they live?" and "where did they live before?" both have real answers.
- **Structurally honest.** If nothing supports an answer, recall abstains *before* the model is asked. No supporting facts, no guess.
- **Inspectable.** Every fact traces to the session that produced it, and can be listed, exported, or deleted individually. Nothing is hidden inside a vector.
- **Multi-tenant.** Every fact is scoped to a required `namespace`. One database serves every user or organisation.
- **Storage-agnostic.** The memory model is implemented once against a `MemoryStore` port. Postgres, SQLite, Neo4j, Memgraph, HydraDB, and an in-memory store are interchangeable — and any adapter is verified by a shipped conformance suite.

---

## Install

```bash
npm install @hymem/core @hymem/sqlite      # or @hymem/postgres, or @hymem/bolt
```

You also need a model. hymem never bundles one — bring any [AI SDK](https://sdk.vercel.ai) provider:

```bash
npm install ai @ai-sdk/openai
```

## Quick start

No database required to try it:

```ts
import { createMemory, memoryStore } from "@hymem/core";
import { openai } from "@ai-sdk/openai";

const memory = createMemory({
  store: memoryStore(),              // swap for postgres()/sqlite()/hydradb() later
  model: openai("gpt-4o-mini"),
  namespace: "demo",                 // required — the tenant boundary
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

await memory.ask("Where do I live now?");
// "Denver, as of the July 20 2026 session."

await memory.ask("Where did I live before that?");
// "Atlanta — you moved there in March 2026 and relocated in July."

await memory.ask("What's my shoe size?");
// "I don't know based on the conversation history."  ← abstained, never reached the model
```

### Recall without an answer

Most agents want the *facts*, not prose — retrieve them and put them in your own prompt:

```ts
const { facts, contextBlock, abstained } = await memory.recall("where do I live?");

if (!abstained) {
  // contextBlock is prompt-ready, chronological, and annotates superseded values:
  //   - [2026-07-20T18:30:00Z · session s2] The user relocated to Denver.
  //       (previously: "Atlanta" until 2026-07-20T18:30:00Z)
  messages.push({ role: "system", content: `What you know:\n${contextBlock}` });
}
```

Building a recall-only memory skips the answerer entirely:

```ts
createMemory({ store, model, namespace, answerer: null });
```

---

## Core concepts

### Facts

Extraction turns a transcript into triples: `(subject, attribute, value)`, plus a sentence, the entities involved, and the source session. A fact's identity is `hash(namespace, subject, attribute, value)` — so re-stating something is idempotent, and re-ingesting a whole history changes nothing.

### Supersession

Two facts collide when they share `(subject, attribute)` inside a namespace but hold different values. The later one wins: the earlier is marked `superseded` and stamped with `validTo`, and a link records what replaced what. Nothing is destroyed, so history stays queryable.

Restating an old value *re-activates* it — moving back to Atlanta reopens that fact rather than creating a third.

### Recall and abstention

A question is mapped to lookup keys (which entities, which attribute slots, and whether it's asking about now, a point in time, or a change), then facts are fetched, filtered against the timeline, and rendered chronologically.

If fewer than `abstainThreshold` facts support the question, `recall()` returns `abstained: true` and `ask()` returns a fixed refusal **without calling the model**. This is the difference between a memory that says "I don't know" and one that confabulates.

### Namespaces

`namespace` is required, with no default — an accidentally shared namespace is a data leak, so it has to be a decision.

```ts
createMemory({ store, model, namespace: `usr_${userId}` })   // personal memory
createMemory({ store, model, namespace: `org_${orgId}` })    // shared team memory
```

One store serves every tenant; the namespace travels with each call, so a thousand tenants share one connection pool rather than needing one each.

### Speakers

A shared namespace needs one more thing or it silently corrupts data. Extraction canonicalises whoever is talking to `"user"`, so without an identity Alice and Bob produce the *same* fact id — and Bob moving to Denver would mark Alice's home city superseded.

```ts
await memory.remember({ ...session, speaker: "usr_alice" });
await memory.recall("where do I live?", { speaker: "usr_alice" });
```

`speaker` is an opaque string you supply; hymem never invents one, because your auth system already has a stable id. Identity never comes from the model — ask an LLM to name the speaker and you get `alice`, `Alice`, and `alice smith` across three sessions.

**One person per namespace needs no speaker** — the namespace is already the identity.

Using an opaque id (`usr_7f3a91`) survives renames and stops two people named Alice colliding, but a question naming "Bob" plans a lookup for the string `bob`. Pass `speakerName` and hymem links both, keeping the id as identity and the name as a working alias:

```ts
await memory.remember({ ...session, speaker: "usr_7f3a91", speakerName: "bob" });
```

<details>
<summary>The <code>"user"</code> token</summary>

`"user"` does double duty: the placeholder for the speaker, and a word people genuinely use. *"The user clicked export and it crashed"* is about a product's end user — but with `speaker` set it would be rewritten into a fact about the speaker.

The substitution only runs when `speaker` is set, so single-speaker namespaces are never exposed. If your domain talks about users literally, change the token:

```ts
createMemory({ store, model, namespace, speakerToken: "__self__" })
```

Custom extractors must emit whatever token you configure.
</details>

---

## Storage adapters

| Store | Package | Peer dependency | Atomic supersede |
| --- | --- | --- | --- |
| In-memory | `@hymem/core` → `memoryStore()` | none | yes |
| SQLite | [`@hymem/sqlite`](packages/sqlite) → `sqlite()` | none (`node:sqlite` is built in) | yes |
| Postgres | [`@hymem/postgres`](packages/postgres) → `postgres()` | `pg` | yes |
| Neo4j | [`@hymem/bolt`](packages/bolt) → `neo4jStore()` | `neo4j-driver` | yes |
| Memgraph | [`@hymem/bolt`](packages/bolt) → `memgraph()` | `neo4j-driver` | yes |
| HydraDB | [`@hymem/bolt`](packages/bolt) → `hydradb()` | `neo4j-driver` | no |
| TiDB / MySQL | [`@hymem/tidb`](packages/tidb) → `tidb()` | `@tidbcloud/serverless` or `mysql2` | yes |
| Cloudflare D1 | [`@hymem/d1`](packages/d1) → `d1()` | none | no |

**`@hymem/core` depends on `zod` and nothing else**, with `ai` as an optional peer. Both store implementations are pure logic — every dependency lives in a *driver*, which is where the package boundary falls. Install the core plus the one adapter you use and you never pull in a database client you won't call.

### Any ORM, without an adapter per ORM

The SQL store is written once against a two-method seam:

```ts
interface SqlDriver {
  dialect: SqlDialect;
  query<T>(sql: string, params: unknown[]): Promise<T[]>;
  transaction?<T>(body: (tx: SqlDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

So pg, better-sqlite3, libSQL, D1, Drizzle (`db.execute`) and Prisma (`$queryRawUnsafe`) are each a ~15-line binding rather than a new adapter. Pass one with `sql(myDriver)`.

### Who owns the schema

hymem **declares** the schema; you **apply** it. Column names are an implementation detail — hand-writing them into your migration would make them public API.

```ts
postgres({ client: pool, migrate: "check" })  // default: verify, else throw with instructions
postgres({ client: pool, migrate: "auto" })   // development: create if absent
postgres({ client: pool, migrate: "off" })    // you ran the DDL yourself
```

`"check"` is the default deliberately: it turns `relation "hymem_facts" does not exist` into an error that names the fix. `"auto"` is wrong for ORM users — it desyncs the database from your schema file, so your next `drizzle-kit generate` produces a bogus diff.

```bash
npx hymem schema --dialect postgres      # DDL for your own migration tool
```

`tablePrefix` (default `hymem_`) keeps hymem clear of your own tables.

### Writing your own adapter

An adapter is ten methods and a passing conformance run — 25 tests covering round-tripping, supersession, re-activation, idempotent re-ingest, ordering, limits, deletion, concurrency, and tenant isolation. It needs no LLM and no API keys.

```ts
import { runStoreConformance } from "@hymem/core/testing";

const result = await runStoreConformance(() => myStore());
console.log(`${result.passed} passed, ${result.failed.length} failed`);
```

### Supersession is one method, deliberately

`supersede(incoming)` closes the facts a new one overwrites, records the chain, and returns the closed ids — in a single port call rather than find → close → link. Those three steps carry an invariant no caller-sequenced version can hold: between the find and the close, another writer can claim the same slot and both end up active.

Keeping it inside the port lets each engine enforce it with what it has — a data-modifying CTE on Postgres, a transaction on SQLite, `executeWrite` on Neo4j. Engines that *can't* say so via `capabilities.atomicSupersede`, and the conformance suite skips the concurrency test for them rather than letting it pass by accident.

### What tenancy is not

This is **application-level isolation, not database-level**. Facts carry a namespace column, every query filters on it, and conformance verifies that search, listing, supersession, deletion, and history all refuse to cross the boundary. But it is still hymem enforcing the rule in SQL it generates.

If you need a guarantee that survives a bug in this library — regulated data, untrusted tenants — put Postgres row-level security underneath it, or give each tenant its own database.

---

## API

### `createMemory(options)`

| Option | Type | Notes |
| --- | --- | --- |
| `store` | `MemoryStore` | **Required.** Where facts live. |
| `namespace` | `string` | **Required.** Tenant boundary; no default. |
| `model` | `LanguageModel` | Fills extractor, planner and answerer with LLM-backed defaults. |
| `speaker` | `string` | Default identity for the human, when one person owns this memory. |
| `speakerToken` | `string` | Placeholder the extractor/planner use. Default `"user"`. |
| `extractor` | `Extractor` | Transcript → facts. Override for rules-based or non-LLM extraction. |
| `planner` | `QueryPlanner` | Question → lookup keys. |
| `answerer` | `Answerer \| null` | Context → prose. `null` builds a recall-only memory. |
| `maxFacts` | `number` | Upper bound on facts pulled into a recall. Default `24`. |
| `abstainThreshold` | `number` | Abstain below this many supporting facts. Default `1`. |

### `Memory`

| Method | Returns |
| --- | --- |
| `remember(session, prevSessionId?)` | `Fact[]` — extract and persist one session |
| `rememberAll(sessions, onProgress?)` | `number` — ingest a history in chronological order |
| `recall(question, { speaker }?)` | `{ facts, contextBlock, abstained, link }` |
| `ask(question, { speaker }?)` | `{ answer, contextBlock, abstained }` |
| `facts(entity?)` | `StoredFact[]` — everything stored, optionally by entity |
| `forget(ids)` | delete facts by id |
| `clear()` | wipe this namespace only |
| `close()` | release the store's connections |

`model` is sugar. Override any stage individually — a rules-based extractor for PII-sensitive domains, a custom prompt, or no answerer at all:

```ts
createMemory({
  store: memoryStore(),
  namespace: "demo",
  extractor: myRulesExtractor,   // no LLM on the write path
  planner: llmPlanner(model),
  answerer: null,                // recall-only; ask() throws
});
```

The pure algorithms are exported too, and import nothing — `ingestSession`, `recall`, `formatContext`, `factId`, `canonEntity`.

---

## CLI

```bash
npm install -g @hymem/cli
```

```bash
export MEM_NAMESPACE=local
export MEM_STORE=sqlite SQLITE_PATH=memory.db MEM_MIGRATE=auto
export LLM_API_KEY=...            # any OpenAI-compatible endpoint

hymem ingest sessions.json         # extract and store facts
hymem ask "where do I live?"       # recall, then answer
hymem recall "..."                 # raw facts, no LLM synthesis
hymem inspect [entity]             # browse what is stored
hymem forget <ids...>              # delete by id
hymem wipe                         # empty the configured namespace
hymem conformance                  # verify the configured store
hymem schema --dialect postgres    # print DDL
```

`hymem schema` and `hymem conformance` need neither a namespace nor a database.

### MCP server

Gives Claude Code — or any MCP client — persistent cross-session memory.

```json
{ "mcpServers": { "hymem": { "command": "npx", "args": ["-y", "@hymem/cli", "hymem-mcp"] } } }
```

Tools: `memory_save`, `memory_recall`, `memory_list`, `memory_forget`.

### Configuration

| Variable | Purpose |
| --- | --- |
| `MEM_NAMESPACE` | **Required.** Tenant boundary. |
| `MEM_STORE` | `sqlite` (default), `postgres`, `neo4j`, `memgraph`, `hydradb`, `memory` |
| `MEM_SPEAKER` | Identity of the human, for shared namespaces |
| `MEM_MAX_FACTS`, `MEM_ABSTAIN_THRESHOLD` | Recall behaviour |
| `MEM_MIGRATE`, `MEM_TABLE_PREFIX` | SQL schema handling |
| `DATABASE_URL` / `SQLITE_PATH` | SQL connection |
| `HYDRA_BOLT_URL`, `HYDRA_TOKEN` / `BOLT_USER`, `BOLT_PASSWORD` | Graph connection |
| `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_BASE_URL` | Model selection |

`LLM_PROVIDER` accepts `openai`, `anthropic`, `google`, or `openai-compatible` — the last, with `LLM_BASE_URL`, covers OpenRouter, Groq, Ollama, LM Studio, vLLM, and DashScope.

---

## Architecture

```
                    ┌─ Extractor ─┐   ┌─ QueryPlanner ─┐   ┌─ Answerer ─┐
                    │  (pluggable) │   │  (pluggable)   │   │ (optional) │
                    └──────┬───────┘   └───────┬────────┘   └─────┬──────┘
                           │                   │                  │
sessions ──▶ extract ──▶ facts              question              │
                           │                   │                  │
                           ▼                   ▼                  │
                  ┌────────────────────────────────────┐          │
                  │   core: ingest · supersede · recall │          │
                  │      (engine-agnostic algorithms)   │          │
                  └────────────────┬───────────────────┘          │
                                   │ MemoryStore port              │
              ┌────────────────────┼────────────────────┐          │
              ▼                    ▼                    ▼          │
        in-memory            Postgres / SQLite     graph stores     │
                                                                    │
                    0 facts → structural abstention ────────────────┤
                                                                    ▼
                                              grounded, supersession-annotated answer
```

Four ports, all replaceable: `MemoryStore` (where facts live), `Extractor` (transcript → facts), `QueryPlanner` (question → lookup keys), and `Answerer` (context → prose, omittable).

## Packages

| Package | Contents |
| --- | --- |
| [`@hymem/core`](packages/core) | ports, algorithms, in-memory store, SQL and Cypher store logic, conformance suite |
| [`@hymem/postgres`](packages/postgres) | `pg` driver + `postgres()` |
| [`@hymem/sqlite`](packages/sqlite) | `node:sqlite` driver + `sqlite()` |
| [`@hymem/bolt`](packages/bolt) | Bolt driver + `neo4jStore()` / `memgraph()` / `hydradb()` |
| [`@hymem/tidb`](packages/tidb) | TiDB Cloud serverless + mysql2 drivers |
| [`@hymem/d1`](packages/d1) | Cloudflare D1 driver, for Workers |
| [`@hymem/cli`](packages/cli) | CLI, MCP server, environment wiring, eval harness |

## Developing this repo

```bash
npm install          # workspace install
npm run build        # tsc --build across all packages
npm run check        # typecheck + every suite that needs no services

npm run conformance sqlite      # real SQL, no services
npm run conformance postgres    # DATABASE_URL=...
npm run conformance neo4j       # NEO4J_URL=... (default bolt://127.0.0.1:7688)
npm run conformance hydradb     # HYDRA_BOLT_URL=...
npm run conformance tidb        # TIDB_URL=... (defaults to mysql://root@127.0.0.1:4000/test)
npm run conformance d1          # no services — Miniflare provides a local D1
```

The benchmark harness ([LongMemEval](https://github.com/xiaowu0162/LongMemEval)) lives in the CLI package:

```bash
npm run -w @hymem/cli eval -- path/to/longmemeval_s.json 50
```

## Status

Early. The memory model, tenancy, and the adapter contract are settled and verified across seven engines. Known gaps:

- **Session/thread querying.** Facts record their source session, but you can't yet filter a recall by session or list sessions.
- **No vector search.** Recall is entity-anchored. `capabilities.vectorSearch` exists for adapters that add it.
- **HydraDB is not atomic** for concurrent supersession — see [`@hymem/bolt`](packages/bolt).

## License

Apache-2.0. See [LICENSE](LICENSE).

Built on [neo4j-driver](https://www.npmjs.com/package/neo4j-driver) for Bolt connectivity, [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk) for the MCP server, and the [AI SDK](https://sdk.vercel.ai) for model access.
