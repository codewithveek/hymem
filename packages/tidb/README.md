# @hymem/tidb

TiDB and MySQL storage for [hymem](https://github.com/codewithveek/hymem) — temporal, multi-tenant memory for AI agents.

TiDB speaks the MySQL protocol, and MySQL differs from Postgres and SQLite in ways that reach the SQL itself: no `RETURNING`, no data-modifying CTEs, `ON DUPLICATE KEY UPDATE` instead of `ON CONFLICT`, and `INSERT IGNORE` as a statement *prefix* rather than a trailing clause. All of that lives in a dialect; the store is the same one every other adapter uses.

## Install

Pick the driver that matches how you reach TiDB.

```bash
npm install @hymem/core @hymem/tidb @tidbcloud/serverless   # HTTP — edge and serverless
npm install @hymem/core @hymem/tidb mysql2                  # wire protocol — Node
```

## TiDB Cloud (serverless, edge-compatible)

```ts
import { createMemory } from "@hymem/core";
import { tidb } from "@hymem/tidb";
import { connect } from "@tidbcloud/serverless";
import { openai } from "@ai-sdk/openai";

const memory = createMemory({
  store: tidb({ connection: connect({ url: process.env.DATABASE_URL }) }),
  model: openai("gpt-4o-mini"),
  namespace: `usr_${userId}`,
});
```

The serverless driver is `fetch`-based, so this runs in Workers, Vercel Edge, and any runtime without raw TCP.

## Self-hosted TiDB or MySQL 8

```ts
import { tidb } from "@hymem/tidb";
import mysql from "mysql2/promise";

const pool = mysql.createPool(process.env.DATABASE_URL);
const store = tidb({ client: pool, migrate: "auto" });
```

`mysql()` is an alias of the same store, for when the database is plain MySQL rather than TiDB.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `connection` | — | A `@tidbcloud/serverless` connection. |
| `client` | — | A `mysql2/promise` pool or connection. One of the two is required. |
| `migrate` | `"check"` | `"check"` verifies and throws with instructions, `"auto"` creates, `"off"` does nothing. |
| `tablePrefix` | `"hymem_"` | Keeps hymem clear of your own tables. |
| `maxParameters` | `65535` | Bind-parameter cap used for chunking. |
| `closeOnEnd` | `true` | Whether `memory.close()` ends the mysql2 client. |

## Atomicity

`atomicSupersede: true` with either driver, provided it can pin a connection — `begin()` on the serverless driver, `getConnection()` on a mysql2 pool.

This matters more here than elsewhere. With no `RETURNING`, supersession has to *read* which facts it is about to close before closing them, and that read-then-write gap is exactly the race a transaction exists to close. A bare mysql2 connection with no `getConnection` omits `transaction`, and the store reports `atomicSupersede: false` rather than pretending.

Issuing `BEGIN` through a pool would be a bug: each statement can land on a different connection, so the `BEGIN` would apply to none of the work that follows.

## Schema

```bash
npx hymem schema --dialect mysql      # DDL for your migration tool
```

Key columns are `VARCHAR(191)` rather than `TEXT`: MySQL cannot index unbounded text, and 191 keeps a composite primary key inside InnoDB's 3072-byte limit under `utf8mb4`.

## Verified

28/28 conformance against a live TiDB, concurrency test included.

## License

Apache-2.0.
