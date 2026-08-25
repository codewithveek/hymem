# @hymem/sqlite

SQLite storage adapter for [hymem](https://github.com/hydra-db/hymem).

No peer dependency: `node:sqlite` ships with Node 22.5+. better-sqlite3 works
too — it wears the same `prepare`/`all`/`run` shape.

```bash
npm install hymem @hymem/sqlite
```

```ts
import { createMemory } from "hymem";
import { sqlite } from "@hymem/sqlite";
import { DatabaseSync } from "node:sqlite";

const memory = createMemory({
  store: sqlite({ database: new DatabaseSync("memory.db"), migrate: "auto" }),
  model,
  namespace: "local",
});
```

Transactions are serialised behind a queue, because SQLite holds one connection
and a second concurrent `BEGIN` fails. That costs nothing: SQLite serialises
writes anyway.
