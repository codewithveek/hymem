# @hymem/cli

CLI and MCP server for [hymem](https://github.com/codewithveek/hymem) — temporal, multi-tenant memory for AI agents.

Two things ship here: a `hymem` command for ingesting, querying and inspecting memory from a terminal, and a `hymem-mcp` server that gives Claude Code (or any MCP client) persistent cross-session memory.

## Install

```bash
npm install -g @hymem/cli
```

## Configure

Configuration is environment-driven, from the shell or a `.env` in the working directory.

```bash
export MEM_NAMESPACE=local                 # required — the tenant boundary
export MEM_STORE=sqlite                    # sqlite needs nothing installed
export SQLITE_PATH=memory.db
export MEM_MIGRATE=auto                    # create tables on first use

export LLM_PROVIDER=openai
export LLM_MODEL=gpt-4o-mini
export LLM_API_KEY=sk-...
```

`MEM_NAMESPACE` has no default: every fact is scoped to it, and an accidentally shared namespace is a data leak. Use a per-user or per-organisation value, or `local` for a single-user setup.

## Commands

```bash
hymem ingest sessions.json          # extract facts from a JSON file of sessions
hymem ask "where do I live?"        # recall, then answer (abstains when unsupported)
hymem ask "..." --facts             # also print the supporting facts
hymem recall "..."                  # raw facts, no LLM synthesis
hymem recall "..." --json           # machine-readable
hymem inspect [entity]              # browse what is stored
hymem forget <ids...>               # delete specific facts
hymem wipe                          # empty the configured namespace
hymem conformance                   # verify the configured store against the contract
hymem schema --dialect postgres     # print DDL for your migration tool
```

`hymem schema` and `hymem conformance` need neither a namespace nor a database.

### Input format

`ingest` takes a JSON array of sessions:

```json
[
  {
    "id": "s1",
    "ts": "2026-03-01T10:00:00Z",
    "idx": 0,
    "turns": [
      { "role": "user", "content": "I just moved to Atlanta for a job at Delta." },
      { "role": "assistant", "content": "Congrats on the move!" }
    ]
  }
]
```

Add `"speaker": "usr_alice"` per session when several people share one namespace, or their facts will collide.

## MCP server

```json
{
  "mcpServers": {
    "hymem": {
      "command": "npx",
      "args": ["-y", "@hymem/cli", "hymem-mcp"],
      "env": { "MEM_NAMESPACE": "local", "MEM_STORE": "sqlite", "SQLITE_PATH": "memory.db", "MEM_MIGRATE": "auto", "LLM_API_KEY": "sk-..." }
    }
  }
}
```

| Tool | Purpose |
| --- | --- |
| `memory_save` | Distil a statement into facts, with supersession |
| `memory_recall` | Retrieve relevant facts; returns "not in memory" rather than guessing |
| `memory_list` | Browse stored facts, optionally by entity |
| `memory_forget` | Delete facts by id |

## Environment reference

| Variable | Purpose |
| --- | --- |
| `MEM_NAMESPACE` | **Required.** Tenant boundary. |
| `MEM_STORE` | `sqlite` (default), `postgres`, `neo4j`, `memgraph`, `hydradb`, `memory` |
| `MEM_SPEAKER` | Identity of the human, for shared namespaces |
| `MEM_SPEAKER_TOKEN` | Extractor placeholder for the speaker. Default `user` |
| `MEM_MAX_FACTS` | Upper bound on facts per recall. Default `24` |
| `MEM_ABSTAIN_THRESHOLD` | Abstain below this many facts. Default `1` |
| `MEM_MIGRATE` | `check` (default), `auto`, `off` |
| `MEM_TABLE_PREFIX` | SQL table prefix. Default `hymem_` |
| `DATABASE_URL` | Postgres connection string |
| `SQLITE_PATH` | SQLite file path |
| `HYDRA_BOLT_URL`, `HYDRA_TOKEN` | HydraDB connection |
| `BOLT_USER`, `BOLT_PASSWORD` | Neo4j / Memgraph basic auth |
| `LLM_PROVIDER` | `openai`, `anthropic`, `google`, `openai-compatible` |
| `LLM_MODEL`, `LLM_API_KEY`, `LLM_BASE_URL` | Model selection |

`openai-compatible` plus `LLM_BASE_URL` covers OpenRouter, Groq, Ollama, LM Studio, vLLM and DashScope.

## Benchmarking

The [LongMemEval](https://github.com/xiaowu0162/LongMemEval) harness is included:

```bash
npm run -w @hymem/cli eval -- path/to/longmemeval_s.json 50
```

Each instance runs against a cleared namespace, so haystacks cannot leak into one another.

## License

Apache-2.0.
