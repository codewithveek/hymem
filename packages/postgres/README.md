# @hymem/postgres

Postgres storage adapter for [hymem](https://github.com/hydra-db/hymem).

```bash
npm install @hymem/core @hymem/postgres pg
```

```ts
import { createMemory } from "@hymem/core";
import { postgres } from "@hymem/postgres";
import { openai } from "@ai-sdk/openai";
import { Pool } from "pg";

const memory = createMemory({
  store: postgres({ client: new Pool({ connectionString: process.env.DATABASE_URL }) }),
  model: openai("gpt-4o-mini"),
  namespace: `usr_${userId}`,
});
```

## Schema

hymem declares the schema; you apply it. `migrate` decides how:

```ts
postgres({ client, migrate: "check" })  // default: verify, else throw with instructions
postgres({ client, migrate: "auto" })   // development: create if absent
postgres({ client, migrate: "off" })    // you ran the DDL yourself
```

Get the DDL for your own migration tool with `hymem schema --dialect postgres`.
`tablePrefix` (default `hymem_`) keeps hymem clear of your own tables.

## Atomicity

Pass a **Pool**, not a bare Client, if you want `atomicSupersede: true`. Issuing
`BEGIN` through a pool is a bug — each statement can land on a different
connection — so the driver pins one via `connect()`. Without it the adapter
degrades honestly rather than pretending.
