# hymem

**Temporal knowledge-graph agent memory on the [HydraDB](https://github.com/hydra-db/hydradb) OSS engine.**
Built for Hack Hydra 2026 · Track 03 (Memory and context retrieval).

Agents forget across sessions, and long-context models fail on exactly three things LongMemEval measures: chronology, information that was later overwritten, and knowing when the answer isn't there. hymem treats memory as what it actually is — a **temporal graph** — instead of a bag of embeddings:

- Facts are `(:Fact)` nodes in HydraDB with validity intervals (`valid_from` / `valid_to`).
- When new information contradicts old information about the same `(subject, attribute)`, the old fact is closed and chained via a `[:SUPERSEDES]` edge — so *"where does the user live?"* and *"where did they live before?"* both have first-class answers.
- Every fact is linked `[:STATED_IN]` to its source session: inspectable, traceable, deletable. No hidden embeddings.
- Recall is **graph traversal** (entity-anchored MATCH + temporal filters), and abstention is **structural**: no supporting facts in the graph → "I don't know based on the conversation history," before an LLM ever gets a chance to guess.

It ships in two usable forms: a CLI/eval pipeline for LongMemEval, and an **MCP server** so Claude Code (or any MCP client) gets persistent cross-session memory backed by the graph.

## How HydraDB is used (and what we'd lose without it)

HydraDB stores the entire memory graph and executes every recall. Ingestion writes batched `UNWIND` Cypher over Bolt (node upserts, then edge merges between matched nodes); the supersession pass closes the old fact with `MATCH ... SET` and chains it with a batched `MERGE (new)-[:SUPERSEDES]->(old)`; recall is an entity-anchored traversal (`(:Fact)-[:ABOUT]->(:Entity {id})`) with the supersession history fetched per fact. Reads are snapshot-consistent, and storage is object-store-native, so the memory survives process restarts and scales past RAM.

HydraDB executes a deliberate **subset** of OpenCypher (see `cypher-compat.md` in the HydraDB repo), and every statement here is written inside it — the rules that matter (integer node ids sent as Bolt INTs, node creation only via `UNWIND ... MERGE ... SET`, no `MATCH ... MERGE`, no `IN`/`coalesce()`, no label-less `MATCH (n)`) are documented at the top of [`src/hydra.ts`](src/hydra.ts). Human-readable ids (fact hashes, entity names, session ids) are mapped to stable 52-bit integers by [`src/ids.ts`](src/ids.ts) and kept on the node as `key`/`name`. `neo4j-driver` is pinned to `~5.27`: from 5.28 the JS driver uses the Bolt manifest handshake, which HydraDB's server answers in several TCP writes and the driver reads as one — a coin-flip connection failure that `src/hydra.ts` also retries around as a backstop.

Without HydraDB there is no supersession chain to walk, no session-provenance edges, and no structural abstention test — a vector index can return "similar" chunks but cannot represent *"this value replaced that one on this date."* That temporal structure is the whole system.

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
sessions ──▶ LLM extraction ──▶ (subject, attribute, value) triples
                                      │  batched UNWIND (Bolt, parameterized)
                                      ▼
                        ┌──────────────────────────────┐
                        │        HydraDB graph          │
                        │ (:Fact)-[:ABOUT]->(:Entity)   │
                        │ (:Fact)-[:STATED_IN]->(:Session)│
                        │ (:Fact)-[:SUPERSEDES]->(:Fact)│
                        └──────────────┬───────────────┘
                                       │ entity-anchored traversal + temporal filter
question ──▶ entity/attribute linking ─┘
                 │ 0 facts → structural abstention
                 ▼
        grounded LLM synthesis (chronological, supersession-annotated)
```

## Repo layout

```
src/hydra.ts       Bolt client (parameterized Cypher, HydraDB dialect helpers) + HTTP fallback
src/ids.ts         string keys → stable integer graph ids
src/extract.ts     LLM fact extraction → deterministic fact ids
src/ingest.ts      session writes + supersession pass
src/retrieve.ts    entity linking, traversal, temporal filtering, abstention
src/answer.ts      grounded synthesis
src/mcp-server.ts  MCP tools: save / recall / list / forget
src/eval.ts        LongMemEval harness
src/cli.ts         ingest | ask | inspect
scripts/run-hydra.sh  local graph-node launcher (env from the HydraDB README)
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

```ts
import { ingestHistory, recall, answer } from "hymem";

await ingestHistory(sessions);
const r = await recall("Where does the user live now?");
if (!r.abstained) console.log(r.contextBlock);
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
