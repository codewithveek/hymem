#!/usr/bin/env node
/**
 * Behaviour checks for the SQL store that sit outside the store conformance
 * contract: schema-ownership modes and the generated DDL.
 */
import { DatabaseSync } from "node:sqlite";
import { sqlite } from "@hymem/sqlite";
import {
  schemaScript,
  assertSafeTablePrefix,
  MissingSchemaError,
  UnsafeTablePrefixError,
  POSTGRES,
  SQLITE,
} from "hymem/stores/sql";

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

console.log(failures === 0 ? "\nall SQL checks passed" : `\n${failures} SQL check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
