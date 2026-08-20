# HydraMem

**Temporal knowledge-graph agent memory on the [HydraDB](https://github.com/hydra-db/hydradb) OSS engine.**
Built for Hack Hydra 2026 · Track 03 (Memory and context retrieval).

Agents forget across sessions, and long-context models fail on exactly three things LongMemEval measures: chronology, information that was later overwritten, and knowing when the answer isn't there. HydraMem treats memory as what it actually is — a **temporal graph** — instead of a bag of embeddings:

- Facts are `(:Fact)` nodes in HydraDB with validity intervals (`valid_from` / `valid_to`).
- When new information contradicts old information about the same `(subject, attribute)`, the old fact is closed and chained via a `[:SUPERSEDES]` edge — so *"where does the user live?"* and *"where did they live before?"* both have first-class answers.
- Every fact is linked `[:STATED_IN]` to its source session: inspectable, traceable, deletable. No hidden embeddings.
- Recall is **graph traversal** (entity-anchored MATCH + temporal filters), and abstention is **structural**: no supporting facts in the graph → "I don't know based on the conversation history," before an LLM ever gets a chance to guess.

It ships in two usable forms: a CLI/eval pipeline for LongMemEval, and an **MCP server** so Claude Code (or any MCP client) gets persistent cross-session memory backed by the graph.

## How HydraDB is used (and what we'd lose without it)

HydraDB stores the entire memory graph and executes every recall. Ingestion writes batched `UNWIND` Cypher over Bolt; the supersession pass is a Cypher `MATCH ... MERGE (new)-[:SUPERSEDES]->(old)`; recall is an entity-anchored traversal returning facts with their supersession history in one query. Reads are snapshot-consistent, and storage is object-store-native, so the memory survives process restarts and scales past RAM.

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
    "hydramem": {
      "command": "npx",
      "args": ["tsx", "/path/to/hydramem/src/mcp-server.ts"],
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
src/hydra.ts       Bolt client (parameterized Cypher) + HTTP fallback
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
