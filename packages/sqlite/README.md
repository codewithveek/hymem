# @hymem/sqlite

SQLite storage for [hymem](https://github.com/codewithveek/hymem) — temporal, multi-tenant memory for AI agents.

**No peer dependency.** `node:sqlite` ships with Node 22.5+, so this is the fastest way to get durable memory on disk with nothing to install and nothing to run. better-sqlite3 works too — it wears the same `prepare`/`all`/`run` shape.

## Install

```bash
npm install @hymem/core @hymem/sqlite
```

## Usage

```ts
import { createMemory } from "@hymem/core";
import { sqlite } from "@hymem/sqlite";
import { openai } from "@ai-sdk/openai";
import { DatabaseSync } from "node:sqlite";

const memory = createMemory({
  store: sqlite({ database: new DatabaseSync("memory.db"), migrate: "auto" }),
  model: openai("gpt-4o-mini"),
  namespace: "local",
});

await memory.remember(session);
const { contextBlock, abstained } = await memory.recall("where do I live?");
```

For tests, an in-memory database gives you a real SQL engine with no files:

```ts
sqlite({ database: new DatabaseSync(":memory:"), migrate: "auto" })
```

With better-sqlite3:

```ts
import Database from "better-sqlite3";
sqlite({ database: new Database("memory.db"), migrate: "auto" });
```

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `database` | — | A `node:sqlite` `DatabaseSync` or a better-sqlite3 `Database`. |
| `migrate` | `"check"` | `"check"` verifies and throws with instructions, `"auto"` creates, `"off"` does nothing. |
| `tablePrefix` | `"hymem_"` | Keeps hymem clear of your own tables. |
| `maxParameters` | `32766` | Node 22's measured cap. Lower it for an old build compiled with `SQLITE_MAX_VARIABLE_NUMBER=999`. |

Setting `maxParameters` too low only costs extra round trips, so it fails safe.

## Schema

hymem declares the schema; you apply it. `migrate: "auto"` is fine for a local database — the reason it isn't the default is that it desyncs an ORM user's database from their schema file.

```bash
npx hymem schema --dialect sqlite     # DDL for your migration tool
```

## Atomicity

`atomicSupersede: true`. Supersession runs inside an explicit transaction, serialised behind a queue.

The queue is there because SQLite holds **one** connection: a second concurrent `BEGIN` fails with *"cannot start a transaction within a transaction"*. Serialising costs nothing, since SQLite serialises writes anyway — it only makes explicit what the engine already does.

## Not for Workers

`node:sqlite` does not exist in Cloudflare Workers or other edge runtimes. Use `@hymem/postgres` against a HTTP-capable Postgres there, or `memoryStore()` from `@hymem/core` for per-request scratch memory. A D1 adapter is planned.

## License

Apache-2.0.
