# @hymem/d1

Cloudflare D1 storage for [hymem](https://github.com/codewithveek/hymem) — temporal, multi-tenant memory for AI agents, running at the edge.

D1 is SQLite, so the SQL is the SQLite dialect unchanged. Two platform limits shape the adapter, and both are handled for you.

## Install

```bash
npm install @hymem/core @hymem/d1
```

No peer dependency — the `D1Database` binding comes from your Worker's `env`.

## Usage

```ts
import { createMemory } from "@hymem/core";
import { d1 } from "@hymem/d1";
import { openai } from "@ai-sdk/openai";

export default {
  async fetch(request: Request, env: Env) {
    const memory = createMemory({
      store: d1({ database: env.DB }),
      model: openai("gpt-4o-mini"),
      namespace: `usr_${userId}`,
    });

    const { contextBlock, abstained } = await memory.recall("where do I live?");
    ...
  },
};
```

`wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "hymem"
database_id = "..."
```

Workers need `nodejs_compat` — `@hymem/core` hashes fact ids with `node:crypto`:

```toml
compatibility_flags = ["nodejs_compat"]
```

## Schema

Apply it with wrangler, not at runtime — a Worker runs on every request, so `migrate: "auto"` would attempt schema work in the hot path.

```bash
npx hymem schema --dialect sqlite > migrations/0001_hymem.sql
wrangler d1 migrations apply hymem
```

Leave `migrate` at its `"check"` default: it turns a missing table into an error that names the fix.

## The two limits

**100 bind parameters per statement.** Roughly 300× tighter than SQLite's own cap. Every list-valued predicate in the store chunks below the dialect's `maxParameters`, so listing a large namespace or deleting many facts issues several statements rather than one oversized one. Nothing to configure.

**No interactive transactions.** D1 offers `batch()` — an atomic array of prepared statements — but a Worker cannot hold a transaction open across round trips: the SQL runs in the database while the JS runs at the edge, and one open write transaction would block the whole database.

Supersession needs to read which facts it is closing before closing them, so it cannot be expressed as a fixed batch. This adapter therefore reports:

```ts
store.capabilities.atomicSupersede === false
```

Single-writer ingest is correct. Two Workers racing to record a change to the same `(subject, attribute)` slot can both observe it unclaimed and both stay active. The conformance suite skips the concurrency test for D1 rather than letting it pass by accident.

If that matters for your workload, serialise writes per user — a Durable Object per namespace is the idiomatic fix — or use `@hymem/postgres` over Hyperdrive.

## Verified

27/28 conformance against a real local D1 (via Miniflare), with the concurrency test correctly skipped.

## License

Apache-2.0.
