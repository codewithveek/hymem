#!/usr/bin/env node
/**
 * Behaviour checks for the SQL store that sit outside the store conformance
 * contract: schema-ownership modes and the generated DDL.
 */
import { DatabaseSync } from "node:sqlite";
import { sqlite } from "@hymem/sqlite";
import { pgDriver, type PgLike } from "@hymem/postgres";
import {
  schemaScript,
  assertSafeTablePrefix,
  MissingSchemaError,
  UnsafeTablePrefixError,
  POSTGRES,
  SQLITE,
} from "@hymem/core/stores/sql";

const NS = "tenant_a";

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? `\n    ${detail}` : ""}`);
  }
}

// --- migrate: "check" refuses to run against an empty database --------------
{
  const store = sqlite({ database: new DatabaseSync(":memory:"), migrate: "check" });
  let thrown: unknown;
  try {
    await store.listFacts(NS);
  } catch (error) {
    thrown = error;
  }
  check("migrate:check throws MissingSchemaError on an empty database", thrown instanceof MissingSchemaError);
  check(
    "the error names the missing table and how to create it",
    thrown instanceof Error &&
      thrown.message.includes("hymem_facts") &&
      thrown.message.includes('migrate: "auto"'),
    thrown instanceof Error ? thrown.message.split("\n")[0] : String(thrown),
  );
}

// --- migrate: "check" catches a HALF-applied schema --------------------------
{
  // Every operation touches all four tables, so verifying only `facts` would
  // pass here and fail later with a raw driver error instead of instructions.
  const database = new DatabaseSync(":memory:");
  database.prepare("CREATE TABLE hymem_facts (id TEXT)").run();
  database.prepare("CREATE TABLE hymem_sessions (id TEXT)").run();
  const store = sqlite({ database, migrate: "check" });
  let thrown: unknown;
  try {
    await store.listFacts(NS);
  } catch (error) {
    thrown = error;
  }
  check(
    "migrate:check rejects a schema missing some of its tables",
    thrown instanceof MissingSchemaError,
    thrown instanceof Error ? thrown.message.split("\n")[0] : String(thrown),
  );
  check(
    "the error names the table that is actually missing",
    thrown instanceof Error && thrown.message.includes("hymem_fact_entities"),
    thrown instanceof Error ? thrown.message.split("\n")[0] : String(thrown),
  );
}

// --- migrate: "auto" creates the schema -------------------------------------
{
  const store = sqlite({ database: new DatabaseSync(":memory:"), migrate: "auto" });
  await store.listFacts(NS);
  check("migrate:auto creates the schema on first use", true);
  await store.close();
}

// --- migrate: "off" leaves the database entirely alone ----------------------
{
  const store = sqlite({ database: new DatabaseSync(":memory:"), migrate: "off" });
  let thrown: unknown;
  try {
    await store.listFacts(NS);
  } catch (error) {
    thrown = error;
  }
  check(
    "migrate:off does not create tables and surfaces the raw driver error",
    thrown !== undefined && !(thrown instanceof MissingSchemaError),
  );
}

// --- tablePrefix keeps hymem out of the way ---------------------------------
{
  const database = new DatabaseSync(":memory:");
  const store = sqlite({ database, migrate: "auto", tablePrefix: "agentmem_" });
  await store.listFacts(NS);
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  const names = tables.map((table) => table.name);
  check(
    "tablePrefix is honoured across every table",
    names.includes("agentmem_facts") && !names.includes("hymem_facts"),
    names.join(", "),
  );
}

// --- generated DDL --------------------------------------------------------
{
  const postgresDdl = schemaScript(POSTGRES);
  const sqliteDdl = schemaScript(SQLITE);
  check("postgres DDL declares all four tables", ["hymem_facts", "hymem_sessions", "hymem_fact_entities", "hymem_supersedes"].every((table) => postgresDdl.includes(table)));
  check("DDL includes the recall and supersession indexes", postgresDdl.includes("_entity_idx") && postgresDdl.includes("_slot_idx"));
  check("sqlite and postgres DDL are both emitted", sqliteDdl.length > 0 && postgresDdl.length > 0);
}

// --- table prefixes are validated, not trusted ------------------------------
{
  // Identifiers cannot be bind parameters, so a prefix is always interpolated.
  const hostile = ['x"; DROP TABLE hymem_facts; --', "a b", "1abc", "a-b", "a;b"];
  const rejected = hostile.every((prefix) => {
    try {
      sqlite({ database: new DatabaseSync(":memory:"), migrate: "auto", tablePrefix: prefix });
      return false;
    } catch (error) {
      return error instanceof UnsafeTablePrefixError;
    }
  });
  check("hostile table prefixes are rejected", rejected);

  const accepted = ["hymem_", "agent_mem_", "_x", "A1_", ""].every((prefix) => {
    try {
      assertSafeTablePrefix(prefix);
      return true;
    } catch {
      return false;
    }
  });
  check("ordinary table prefixes are still accepted", accepted);
}

// --- list predicates stay under the bind-parameter cap ----------------------
{
  // Node 22's SQLite accepts 32766 parameters (measured), so a realistic list
  // would not exercise chunking at all. Force it with a tiny cap instead: the
  // chunk loop is what is under test, not the driver's ceiling.
  const store = sqlite({
    database: new DatabaseSync(":memory:"),
    migrate: "auto",
    maxParameters: 12,
  });
  const many = Array.from({ length: 500 }, (_, index) => `fact_${index}`);

  let deleteError: unknown;
  try {
    await store.deleteFacts(NS, many);
  } catch (error) {
    deleteError = error;
  }
  check(
    "deleteFacts chunks a list larger than the parameter cap",
    deleteError === undefined,
    deleteError instanceof Error ? deleteError.message.slice(0, 120) : "",
  );

  // And confirm the unchunked form really would have failed, so the check above
  // is not passing vacuously.
  const raw = new DatabaseSync(":memory:");
  raw.prepare("CREATE TABLE t (id TEXT)").run();
  let rawError: unknown;
  try {
    const placeholders = Array(40000).fill("?").join(",");
    raw.prepare(`SELECT * FROM t WHERE id IN (${placeholders})`).all(...Array(40000).fill("x"));
  } catch (error) {
    rawError = error;
  }
  check("an unchunked list past the driver ceiling really does fail", rawError !== undefined);

  // listFacts binds one parameter per returned row when attaching entities.
  const observedAt = "2024-01-01T00:00:00Z";
  await store.putSession(NS, { id: "s1", ts: observedAt, idx: 0 });
  await store.putFacts(
    many.map((id) => ({
      id,
      namespace: NS,
      subject: "user",
      attribute: id,
      value: "v",
      text: "t",
      entities: ["user"],
      observedAt,
      sessionId: "s1",
      status: "active" as const,
      validFrom: observedAt,
      validTo: null,
    })),
  );
  await store.linkEntities(NS, many.map((id) => ({ factId: id, entity: "user" })));

  let listError: unknown;
  let listed = 0;
  try {
    listed = (await store.listFacts(NS)).length;
  } catch (error) {
    listError = error;
  }
  check(
    "listFacts chunks entity attachment beyond the parameter cap",
    listError === undefined && listed === many.length,
    listError instanceof Error ? listError.message.slice(0, 120) : `listed ${listed}`,
  );
  await store.close();
}

// --- search chunks its list predicates too -----------------------------------
{
  // search binds one parameter per entity AND one per attribute, so a wide
  // query has to be split exactly as listFacts and deleteFacts are.
  const store = sqlite({
    database: new DatabaseSync(":memory:"),
    migrate: "auto",
    maxParameters: 12,
  });
  const observedAt = "2024-01-01T00:00:00Z";
  await store.putSession(NS, { id: "s1", ts: observedAt, idx: 0 });
  await store.putFacts([
    {
      id: "needle",
      namespace: NS,
      subject: "user",
      attribute: "home_city",
      value: "lisbon",
      text: "the user lives in lisbon",
      entities: ["user"],
      observedAt,
      sessionId: "s1",
      status: "active" as const,
      validFrom: observedAt,
      validTo: null,
    },
  ]);
  await store.linkEntities(NS, [{ factId: "needle", entity: "user" }]);

  // The real entity and attribute are buried in lists far past the cap.
  const entities = [...Array.from({ length: 40 }, (_, index) => `entity_${index}`), "user"];
  const attributes = [
    ...Array.from({ length: 40 }, (_, index) => `attribute_${index}`),
    "home_city",
  ];

  let searchError: unknown;
  let found: string[] = [];
  try {
    found = (await store.search({ namespace: NS, entities, attributes, limit: 10 })).map(
      (fact) => fact.id,
    );
  } catch (error) {
    searchError = error;
  }
  check(
    "search chunks entity and attribute lists beyond the parameter cap",
    searchError === undefined && found.length === 1 && found[0] === "needle",
    searchError instanceof Error ? searchError.message.slice(0, 120) : `found ${found.join(", ")}`,
  );
  await store.close();
}

// --- close is idempotent ----------------------------------------------------
{
  // DatabaseSync.close() throws when the database is already closed, so an
  // application that closes twice during shutdown must not see that error.
  const store = sqlite({ database: new DatabaseSync(":memory:"), migrate: "auto" });
  await store.listFacts(NS);
  await store.close();
  let secondCloseError: unknown;
  try {
    await store.close();
  } catch (error) {
    secondCloseError = error;
  }
  check(
    "closing the store twice is harmless",
    secondCloseError === undefined,
    secondCloseError instanceof Error ? secondCloseError.message.slice(0, 120) : "",
  );
}

// --- the pg driver tells a Pool from a Client --------------------------------
{
  // A Pool and a Client both expose connect(), but only a Pool hands back a
  // connection to release. Getting this wrong means transactions — and so
  // atomic supersession — break for one of the two advertised inputs. Fakes
  // stand in for `pg` here so the check needs no database.
  const recordQueries = (log: string[]) => async (sql: string) => {
    log.push(sql);
    return { rows: [] };
  };

  const poolLog: string[] = [];
  const checkoutLog: string[] = [];
  let released = 0;
  const pool: PgLike = {
    query: recordQueries(poolLog),
    connect: async () => ({
      query: recordQueries(checkoutLog),
      release: () => {
        released++;
      },
    }),
  };
  await pgDriver(pool).transaction!(async (tx) => tx.query("SELECT 1", []));
  check(
    "a pool runs the transaction on a checked-out connection, then releases it",
    checkoutLog.join(" ") === "BEGIN SELECT 1 COMMIT" && released === 1 && poolLog.length === 0,
    `pool=[${poolLog.join(", ")}] checkout=[${checkoutLog.join(", ")}] released=${released}`,
  );

  // node-postgres rejects a second connect() on an already-connected Client,
  // which is how one normally arrives here.
  const connectedClientLog: string[] = [];
  const connectedClient: PgLike = {
    query: recordQueries(connectedClientLog),
    connect: async () => {
      throw new Error("Client has already been connected. You cannot reuse a client.");
    },
  };
  await pgDriver(connectedClient).transaction!(async (tx) => tx.query("SELECT 1", []));
  check(
    "an already-connected Client runs the transaction on itself",
    connectedClientLog.join(" ") === "BEGIN SELECT 1 COMMIT",
    `[${connectedClientLog.join(", ")}]`,
  );

  // A fresh Client connects itself and resolves to nothing.
  const freshClientLog: string[] = [];
  let connects = 0;
  const freshClient: PgLike = {
    query: recordQueries(freshClientLog),
    connect: async () => {
      connects++;
    },
  };
  const freshDriver = pgDriver(freshClient);
  await freshDriver.transaction!(async (tx) => tx.query("SELECT 1", []));
  await freshDriver.transaction!(async (tx) => tx.query("SELECT 2", []));
  check(
    "a fresh Client is connected once and reused for later transactions",
    connects === 1 && freshClientLog.join(" ") === "BEGIN SELECT 1 COMMIT BEGIN SELECT 2 COMMIT",
    `connects=${connects} [${freshClientLog.join(", ")}]`,
  );

  // A connect() failure that is not "already connected" belongs to the caller:
  // silently falling back would issue BEGIN through a pool, where every
  // statement may land on a different connection.
  const unreachable: PgLike = {
    query: async () => ({ rows: [] }),
    connect: async () => {
      throw new Error("ECONNREFUSED");
    },
  };
  let connectError: unknown;
  try {
    await pgDriver(unreachable).transaction!(async () => undefined);
  } catch (error) {
    connectError = error;
  }
  check(
    "a real connection failure surfaces instead of degrading to a pool BEGIN",
    connectError instanceof Error && connectError.message.includes("ECONNREFUSED"),
    connectError instanceof Error ? connectError.message : String(connectError),
  );

  // A rollback must reach the same connection the work ran on.
  const rollbackLog: string[] = [];
  const rollbackPool: PgLike = {
    query: async () => ({ rows: [] }),
    connect: async () => ({ query: recordQueries(rollbackLog), release: () => undefined }),
  };
  let bodyError: unknown;
  try {
    await pgDriver(rollbackPool).transaction!(async () => {
      throw new Error("body failed");
    });
  } catch (error) {
    bodyError = error;
  }
  check(
    "a failing transaction body rolls back and rethrows",
    bodyError instanceof Error && rollbackLog.join(" ") === "BEGIN ROLLBACK",
    `[${rollbackLog.join(", ")}] error=${bodyError instanceof Error ? bodyError.message : bodyError}`,
  );

  // pg throws "Called end on pool more than once" on the second end().
  let ends = 0;
  const closingPool: PgLike = {
    query: async () => ({ rows: [] }),
    end: async () => {
      ends++;
    },
  };
  const closingDriver = pgDriver(closingPool);
  await closingDriver.close();
  await closingDriver.close();
  check("the pg driver ends its client only once", ends === 1, `ends=${ends}`);
}

console.log(failures === 0 ? "\nall SQL checks passed" : `\n${failures} SQL check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
