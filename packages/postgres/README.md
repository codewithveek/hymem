# @hymem/postgres

Postgres storage for [hymem](https://github.com/codewithveek/hymem) — temporal, multi-tenant memory for AI agents.

Facts become rows. Entities and supersession become join tables. Recall is a join and an `ORDER BY`. No graph emulation, no JSON blobs, and real indexes on the columns that matter.

## Install

```bash
npm install @hymem/core @hymem/postgres pg
```

## Usage

```ts
import { createMemory } from "@hymem/core";
import { postgres } from "@hymem/postgres";
import { openai } from "@ai-sdk/openai";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const memory = createMemory({
  store: postgres({ client: pool, migrate: "auto" }),   // "auto" for development
  model: openai("gpt-4o-mini"),
  namespace: `usr_${userId}`,
});

await memory.remember(session);
const { contextBlock, abstained } = await memory.recall("where do I live?");
```

One pool serves every tenant — the namespace travels with each query rather than being baked into the store, so a thousand tenants do not need a thousand pools.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `client` | — | A `pg` Pool or Client, or anything with the same shape (Neon serverless, Drizzle's session). |
| `migrate` | `"check"` | `"check"` verifies and throws with instructions, `"auto"` creates, `"off"` does nothing. |
| `tablePrefix` | `"hymem_"` | Keeps hymem clear of your own `facts` / `sessions` tables. |
| `maxParameters` | `65535` | Bind-parameter cap used for chunking large lists. |
| `closeOnEnd` | `true` | Whether `memory.close()` ends the underlying client. |

## Schema

hymem **declares** the schema; you **apply** it. Column names are an implementation detail — hand-writing them into your migration would make them public API, and every future change a breaking one.

```bash
npx hymem schema --dialect postgres     # DDL for your migration tool
```

`"check"` is the default deliberately: it turns `relation "hymem_facts" does not exist` into an error that names the fix. `"auto"` is wrong for ORM users — it desyncs the database from your schema file, so your next `drizzle-kit generate` produces a bogus diff.

Four tables (`hymem_facts`, `hymem_sessions`, `hymem_fact_entities`, `hymem_supersedes`), each index leading with `namespace` so one tenant's volume never slows another's lookups.

## Atomicity

Pass a **Pool**, not a bare Client, to get `atomicSupersede: true`.

Supersession runs as one data-modifying CTE — `WITH closed AS (UPDATE … RETURNING) INSERT …` — so closing the old value and recording the chain commit as a single statement, with no window for a second writer to claim the same slot.

Where a transaction is needed instead, the driver pins one connection via `connect()`. Issuing `BEGIN` through a pool is a bug: each statement can land on a different connection, so the `BEGIN` would apply to none of the work that follows. Without `connect()` the adapter degrades honestly rather than pretending.

## Bring your own client

Anything that runs parameterised SQL works — the store is written against a two-method driver seam:

```ts
import { sql } from "@hymem/core/stores/sql";

const store = sql({
  dialect: POSTGRES,
  query: (text, params) => myClient.query(text, params).then((r) => r.rows),
  close: async () => {},
});
```

## License

Apache-2.0.
