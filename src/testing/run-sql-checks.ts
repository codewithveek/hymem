#!/usr/bin/env node
/**
 * Behaviour checks for the SQL store that sit outside the store conformance
 * contract: schema-ownership modes and the generated DDL.
 */
import { DatabaseSync } from "node:sqlite";
import { sqlite, schemaScript, MissingSchemaError, POSTGRES, SQLITE } from "../stores/sql/index.js";

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

console.log(failures === 0 ? "\nall SQL checks passed" : `\n${failures} SQL check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
