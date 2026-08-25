# @hymem/cli

CLI and MCP server for [hymem](https://github.com/hydra-db/hymem).

```bash
npm install -g @hymem/cli
```

```bash
hymem ingest sessions.json      # extract and store facts
hymem ask "where do I live?"    # recall, then answer (abstains when unsupported)
hymem recall "..."              # raw facts, no LLM synthesis
hymem inspect [entity]          # browse what is stored
hymem forget <ids...>           # delete by id
hymem wipe                      # empty the configured namespace
hymem conformance               # verify the configured store against the contract
hymem schema --dialect postgres # print DDL for your migration tool
```

Configuration is environment-driven; see `.env.example`. `MEM_NAMESPACE` is
required — it is the tenant boundary, and there is no default because an
accidentally shared namespace is a data leak.

`hymem schema` and `hymem conformance` need neither a namespace nor a database.

## MCP server

```json
{ "mcpServers": { "hymem": { "command": "hymem-mcp" } } }
```

Tools: `memory_save`, `memory_recall`, `memory_list`, `memory_forget`.
