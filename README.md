# hymem

**Temporal knowledge-graph agent memory, with pluggable storage.**
Originally built for Hack Hydra 2026 · Track 03 (Memory and context retrieval).

Agents forget across sessions, and long-context models fail on exactly three things LongMemEval measures: chronology, information that was later overwritten, and knowing when the answer isn't there. hymem treats memory as what it actually is — a **temporal graph** — instead of a bag of embeddings:

- Facts carry validity intervals (`validFrom` / `validTo`), so every value has a lifetime rather than just a latest state.
- When new information contradicts old information about the same `(subject, attribute)`, the old fact is closed and chained via a `[:SUPERSEDES]` edge — so *"where does the user live?"* and *"where did they live before?"* both have first-class answers.
- Every fact is linked to its source session: inspectable, traceable, deletable. No hidden embeddings.
- Recall is **entity-anchored lookup + temporal filtering**, and abstention is **structural**: no supporting facts → "I don't know based on the conversation history," before an LLM ever gets a chance to guess.
- **The storage engine is an adapter.** The memory model above is implemented once, against a `MemoryStore` port; HydraDB, Neo4j, Memgraph, and a zero-dependency in-memory store are interchangeable, and any adapter is verifiable against a shipped conformance suite.

It ships in two usable forms: a CLI/eval pipeline for LongMemEval, and an **MCP server** so Claude Code (or any MCP client) gets persistent cross-session memory backed by the graph.

## Storage adapters

The memory model — extraction, fact identity, supersession, bitemporal validity, entity-anchored recall, structural abstention — lives in `src/core/` and knows nothing about any engine. Persistence is a port, `MemoryStore` ([`src/core/ports.ts`](src/core/ports.ts)): about nine methods that speak *facts*, not nodes or rows.

| Store | Import | Needs |
| --- | --- | --- |
| In-memory | `hymem` → `memoryStore()` | nothing |
| SQLite | `hymem/stores/sql` → `sqlite()` | `node:sqlite` (built in) or better-sqlite3 |
| Postgres | `hymem/stores/sql` → `postgres()` | `pg` |
| HydraDB | `hymem/stores/cypher` → `hydradb()` | a graph-node over Bolt |
| Neo4j | `hymem/stores/cypher` → `neo4j()` | Neo4j 5.x |
| Memgraph | `hymem/stores/cypher` → `memgraph()` | Memgraph |

Every adapter is checked against the same executable contract:

```bash
npm run conformance            # in-memory reference store
npm run conformance sqlite     # real SQL, no install (node:sqlite)
npm run conformance postgres   # a live Postgres
npm run conformance hydradb    # a live HydraDB node
```

All four pass the identical 15 tests. That the same nine methods land naturally on a property graph *and* on four SQL tables is the evidence the port sits at the right altitude.

### Any ORM, without an adapter per ORM

The SQL store is written once against a two-method driver seam:

```ts
interface SqlDriver {
  dialect: SqlDialect;
  query<T>(sql: string, params: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}
```

So pg, better-sqlite3, libSQL, D1, Drizzle (`db.execute`) and Prisma (`$queryRawUnsafe`) are each a ~15-line binding, not a new adapter. Pass one with `sql(myDriver)`.

### Who owns the schema

hymem **declares** the schema; you **apply** it. Column names are an implementation detail — hand-writing them into your migration would make them public API, so the definition stays in the adapter and only the application path is yours:

```ts
postgres({ client: pool, migrate: "check" })  // default: verify, else throw with instructions
postgres({ client: pool, migrate: "auto" })   // dev: create if absent
postgres({ client: pool, migrate: "off" })    // you ran the DDL yourself
```

`"check"` is the default deliberately: it turns `relation "hymem_facts" does not exist` into an error that names the fix. `"auto"` is wrong for ORM users — it desyncs the database from your schema file, so your next `drizzle-kit generate` produces a bogus diff. Get the DDL for your own migration tool with:

```bash
npm run schema -- --dialect postgres          # or sqlite, and --prefix
```

`tablePrefix` (default `hymem_`) keeps hymem clear of your own `facts` and `sessions` tables.

Writing your own adapter is implementing the nine methods and making `runStoreConformance` pass — 15 tests covering round-tripping, supersession, re-activation, idempotent re-ingest, ordering, limits, and deletion semantics. It needs no LLM and no API keys.

### How HydraDB is used

Ingestion writes batched `UNWIND` Cypher over Bolt (node upserts, then edge merges between matched nodes); the supersession pass closes the old fact with `MATCH ... SET` and chains it with a batched `MERGE (new)-[:SUPERSEDES]->(old)`; recall is an entity-anchored traversal (`(:Fact)-[:ABOUT]->(:Entity {id})`). Reads are snapshot-consistent, and storage is object-store-native, so the memory survives process restarts and scales past RAM.

HydraDB executes a deliberate **subset** of OpenCypher (see `cypher-compat.md` in the HydraDB repo), and every statement is written inside it. The rules that matter — integer node ids sent as Bolt INTs, node creation only via `UNWIND ... MERGE ... SET`, no `MATCH ... MERGE`, no `IN`/`coalesce()`, no label-less `MATCH (n)` — are captured as a `Dialect` in [`src/stores/cypher/dialect.ts`](src/stores/cypher/dialect.ts), which is also what lets Neo4j and Memgraph share one implementation. The integer-id mapping is private to the adapter: the rest of hymem only ever sees a fact's string hash. `neo4j-driver` is pinned to `~5.27`: from 5.28 the JS driver uses the Bolt manifest handshake, which HydraDB's server answers in several TCP writes and the driver reads as one — a coin-flip connection failure that [`src/stores/cypher/driver.ts`](src/stores/cypher/driver.ts) also retries around as a backstop.

## Quick start

```bash
# 1. Build & run a local HydraDB node (Rust 1.91+, libcypher-parser, GraphBLAS — see the HydraDB README)
git clone https://github.com/hydra-db/hydradb.git ~/hydradb
HYDRADB_REPO=~/hydradb bash scripts/run-hydra.sh   # runs in the foreground

# 2. In another shell: install, configure, verify
npm install
cp .env.example .env    # set LLM_API_KEY (any OpenAI-compatible endpoint)
npm run bootstrap       # round-trips a write through the node

# 3. Use it
npm run ingest -- examples/sessions.json
npm run ask -- "Where does the user live now?"
npm run ask -- "Where did the user live before that?"
npm run inspect -- user

# 4. Benchmark (LongMemEval)
npm run eval -- path/to/longmemeval_s.json 50
```

### MCP server (Claude Code and friends)

```json
{
  "mcpServers": {
    "hymem": {
      "command": "npx",
      "args": ["tsx", "/path/to/hymem/src/mcp-server.ts"],
      "env": { "LLM_API_KEY": "..." }
    }
  }
}
```

Tools: `memory_save`, `memory_recall`, `memory_list`, `memory_forget`. Tool descriptions instruct the agent to recall before answering history questions and to save durable facts — no custom protocol to learn.

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
        in-memory            HydraDB / Neo4j        your adapter    │
                                                                    │
                    0 facts → structural abstention ────────────────┤
                                                                    ▼
                                              grounded, supersession-annotated answer
```

Four ports, all replaceable: `MemoryStore` (where facts live), `Extractor` (transcript → facts), `QueryPlanner` (question → lookup keys), `Answerer` (context → prose, and omittable — agent authors usually want `recall()` and their own prompt).

## Repo layout

```
src/core/types.ts        domain types — no engine, no I/O
src/core/ports.ts        MemoryStore, Extractor, QueryPlanner, Answerer
src/core/ingest.ts       session writes + supersession pass (engine-agnostic)
src/core/recall.ts       temporal filtering, context formatting (engine-agnostic)
src/core/memory.ts       createMemory() — the public API
src/core/ids.ts          fact identity + entity canonicalisation
src/stores/memory-store.ts   zero-dependency reference store
src/stores/cypher/       Bolt driver, dialects, MemoryStore over a property graph
src/stores/sql/          SQL driver seam, dialects, schema ownership, MemoryStore over tables
src/llm/                 LLM-backed extractor / planner / answerer + JSON repair
src/testing/conformance.ts   the executable MemoryStore contract
src/env.ts               the only module that reads process.env (CLI/MCP/eval)
src/cli.ts               ingest | ask | recall | inspect | forget | conformance
src/mcp-server.ts        MCP tools: save / recall / list / forget
src/eval.ts              LongMemEval harness
```

## Known adjustments on first run

- **Bolt auth scheme** (`src/hydra.ts`): try `neo4j.auth.bearer(token)` first, then `basic("", token)`; mirror what `scripts/runtime_smoke.sh` in the HydraDB repo does.
- **HTTP response shape** (`src/hydra.ts` fallback): confirm the rows field name against a live node.
- The node **must** run with `RUST_MIN_STACK=33554432` (handled by `scripts/run-hydra.sh`).

## Attributions

- [HydraDB](https://github.com/hydra-db/hydradb) (AGPL-3.0) — graph storage and query engine (run as an external server; not linked or modified).
- [LongMemEval](https://github.com/xiaowu0162/LongMemEval) — benchmark dataset.
- [neo4j-driver](https://www.npmjs.com/package/neo4j-driver) — Bolt connectivity.
- [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk) — MCP server.
- LLM calls via an OpenAI-compatible API (configurable).
- Portions of this scaffold were drafted with an AI coding assistant during the hackathon window.

## License

Apache-2.0 (this project's code). HydraDB itself is AGPL-3.0 and is used unmodified as an external service.

## Choosing an LLM provider

hymem uses the Vercel AI SDK, so any provider works via env vars — no code changes:

| Provider | .env |
|---|---|
| OpenAI | `LLM_PROVIDER=openai` `LLM_MODEL=gpt-4o-mini` |
| Anthropic | `LLM_PROVIDER=anthropic` `LLM_MODEL=claude-sonnet-4-5` |
| Google | `LLM_PROVIDER=google` `LLM_MODEL=gemini-2.0-flash` |
| OpenRouter / Groq / Ollama / vLLM / LM Studio | `LLM_PROVIDER=openai-compatible` `LLM_BASE_URL=...` `LLM_MODEL=...` |

Structured extraction uses `generateObject` with zod schemas, so fact JSON is validated by the SDK — no hand-rolled parsing.

## Using hymem as a library

Everything is injected — no globals, no environment reads, no bundled LLM provider. Two memories with different stores can coexist in one process.

```ts
import { createMemory } from "hymem";
import { hydradb } from "hymem/stores/cypher";
import { openai } from "@ai-sdk/openai";

const memory = createMemory({
  store: hydradb({ url: "bolt://127.0.0.1:7687", token: process.env.HYDRA_TOKEN }),
  model: openai("gpt-4o-mini"),
  abstainThreshold: 1,
  maxFacts: 24,
});

await memory.rememberAll(sessions);

const recalled = await memory.recall("Where does the user live now?");
if (!recalled.abstained) console.log(recalled.contextBlock);
```

`model` is sugar: it fills the extractor, planner, and answerer with LLM-backed defaults. Override any one of them — a rules-based extractor for PII-sensitive domains, a custom prompt, or no answerer at all:

```ts
const memory = createMemory({
  store: memoryStore(),
  extractor: myRulesExtractor,   // no LLM on the write path
  planner: llmPlanner(model),
  answerer: null,                // recall-only; ask() throws
});
```

### Writing a store adapter

```ts
import { runStoreConformance } from "hymem/testing";

const result = await runStoreConformance(() => myStore());
console.log(`${result.passed} passed, ${result.failed.length} failed`);
```

## Publishing to npm

```bash
npm login
npm run typecheck && npm run build   # also runs automatically via prepublishOnly
npm pack --dry-run                    # verify only dist/, README, LICENSE ship
npm publish --access public
```

After publishing, the two binaries work anywhere:

```bash
npx hymem inspect user
npx hymem-mcp        # MCP config: { "command": "npx", "args": ["-y", "hymem-mcp"] }
```

## Production hardening checklist (post-hackathon)

- **Reliability:** retries with backoff + timeouts on LLM and Bolt calls; health endpoint; graceful shutdown.
- **Correctness:** unit tests (vitest) for supersession and temporal filtering; an idempotency test (re-ingesting the same session must not duplicate); a small golden-question regression suite wired into CI.
- **Concurrency:** serialize the supersession pass per (subject, attribute) — two parallel ingests can race; a queue or per-key lock fixes it.
- **Multi-tenancy:** one HydraDB namespace/graph per user or team; never mix tenants in one graph.
- **Security:** real token management (no default token), TLS to the node (drop GRAPH_ALLOW_PLAINTEXT), PII redaction option before facts are stored, authz on MCP tools.
- **Observability:** structured logging (pino), latency/error metrics per pipeline stage, trace ids from question → facts → answer.
- **Data ops:** export/erase-per-user commands (GDPR), TTL sweep for stale episodic facts, periodic consolidation job.
- **Retrieval quality:** add embedding-based entity aliasing and a hybrid rerank as a fallback when entity linking misses; index Entity.name and Fact.id in HydraDB if/when index DDL is available.
- **Packaging:** CI (GitHub Actions: typecheck, build, tests), changesets for versioning, provenance-signed npm publish.

## Cross-platform notes (Linux / macOS / Windows)

**Env vars.** `config.ts` loads `.env` from the working directory with Node's built-in `process.loadEnvFile()` — no `source`, no `export`, no `set`, no extra dependency. The same `.env` file works in bash, PowerShell, and cmd. Variables already set in the shell/CI/Docker take precedence over the file. Requires Node >= 20.12.

**The TypeScript side is fully portable.** `npm run …`, the CLI, and the MCP server run natively on all three OSes; npm generates `.cmd` shims for the `hymem` and `hymem-mcp` binaries on Windows automatically. No npm script sets env vars inline, so `cross-env` isn't needed.

**The HydraDB node itself** is where platforms differ, because the Rust engine needs libcypher-parser and SuiteSparse:GraphBLAS:

| Platform | Recommended way to run the node |
|---|---|
| Linux / macOS | `HYDRADB_REPO=~/hydradb bash scripts/run-hydra.sh` |
| Windows (best) | Docker Desktop: `docker compose up --build` — the container is Linux, so the build is identical everywhere |
| Windows (alt) | WSL2: run `scripts/run-hydra.sh` inside Ubuntu; ports are reachable from Windows at 127.0.0.1 |
| Windows (native) | `scripts/run-hydra.ps1` — only if you can source the native C dependencies; not recommended under deadline |

`.gitattributes` pins `.sh` files to LF so the bash script isn't broken by CRLF checkouts on Windows.
