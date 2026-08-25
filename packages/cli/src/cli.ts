#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { memoryFromEnv, namespaceFromEnv, storeFromEnv } from "./env.js";
import { runStoreConformance, CONFORMANCE_TEST_COUNT } from "@hymem/core/testing";
import type { SessionInput } from "@hymem/core";
import type { Memory } from "@hymem/core";

/**
 * Built on first use, not at startup: `schema` and `conformance` need neither a
 * namespace nor a database connection, and requiring MEM_NAMESPACE to print DDL
 * would be absurd.
 */
let memoryInstance: Memory | undefined;
const getMemory = async (): Promise<Memory> => (memoryInstance ??= await memoryFromEnv());

const program = new Command();

program
  .name("hymem")
  .description("Temporal knowledge-graph agent memory — store-agnostic, multi-tenant")
  .version("0.3.0")
  .hook("postAction", async () => {
    await memoryInstance?.close();
  });

program
  .command("ingest")
  .description("Ingest a JSON file of sessions into memory")
  .argument("<file>", "path to a SessionInput[] JSON file")
  .action(async (file: string) => {
    const sessions = JSON.parse(readFileSync(file, "utf8")) as SessionInput[];
    const factCount = await (await getMemory()).rememberAll(sessions, (session, facts) => {
      console.error(`  ingested ${session.id} (${facts.length} facts)`);
    });
    console.log(`Done: ${sessions.length} sessions, ${factCount} facts.`);
  });

program
  .command("ask")
  .description("Ask a question against memory (abstains when unsupported)")
  .argument("<question...>", "natural-language question")
  .option("--facts", "also print the supporting facts")
  .action(async (parts: string[], options: { facts?: boolean }) => {
    const answered = await (await getMemory()).ask(parts.join(" "));
    console.log(answered.answer);
    if (options.facts && !answered.abstained) {
      console.log(`\n--- supporting facts ---\n${answered.contextBlock}`);
    }
  });

program
  .command("recall")
  .description("Raw recall: print matching facts without LLM synthesis")
  .argument("<question...>", "natural-language question")
  .option("--json", "output as JSON")
  .action(async (parts: string[], options: { json?: boolean }) => {
    const recalled = await (await getMemory()).recall(parts.join(" "));
    if (options.json) console.log(JSON.stringify(recalled.facts, null, 2));
    else console.log(recalled.abstained ? "Not in memory." : recalled.contextBlock);
  });

program
  .command("inspect")
  .description("List stored facts, optionally filtered by entity")
  .argument("[entity]", "entity name filter, e.g. user")
  .option("--json", "output as JSON")
  .action(async (entity: string | undefined, options: { json?: boolean }) => {
    const memory = await getMemory();
    const facts = await memory.facts(entity);
    if (options.json) {
      console.log(JSON.stringify(facts, null, 2));
      return;
    }
    for (const fact of facts) {
      console.log(
        `[${fact.status}] ${fact.observedAt} · ${fact.text}  (id ${fact.id}, session ${fact.sessionId})`,
      );
    }
    console.log(`\n${facts.length} fact(s) in namespace "${memory.namespace}".`);
  });

program
  .command("forget")
  .description("Delete facts by id (ids from `hymem inspect`)")
  .argument("<ids...>", "fact ids")
  .action(async (ids: string[]) => {
    await (await getMemory()).forget(ids);
    console.log(`Deleted ${ids.length} fact(s).`);
  });

program
  .command("conformance")
  .description("Verify the configured store against the MemoryStore contract")
  .action(async () => {
    const store = await storeFromEnv();
    console.log(`Running ${CONFORMANCE_TEST_COUNT} conformance tests against ${process.env.MEM_STORE ?? "hydradb"}:\n`);
    console.log('(the suite uses its own "tenant_a"/"tenant_b" namespaces)\n');
    const result = await runStoreConformance(() => store, { verbose: true });
    console.log(
      `\n${result.passed} passed, ${result.failed.length} failed, ${result.skipped.length} skipped`,
    );
    await store.close();
    if (result.failed.length > 0) process.exitCode = 1;
  });

program
  .command("wipe")
  .description("Delete every fact in the configured namespace")
  .action(async () => {
    const namespace = namespaceFromEnv();
    await (await getMemory()).clear();
    console.log(`Wiped namespace "${namespace}".`);
  });

program
  .command("schema")
  .description("Print the SQL DDL for a store, to apply through your own migration tool")
  .option("--dialect <name>", "postgres | sqlite", "postgres")
  .option("--prefix <prefix>", "table-name prefix", "hymem_")
  .action(async (options: { dialect: string; prefix: string }) => {
    const { schemaScript, POSTGRES, SQLITE } = await import("@hymem/core/stores/sql");
    const dialects = { postgres: POSTGRES, sqlite: SQLITE };
    const dialect = dialects[options.dialect as keyof typeof dialects];
    if (!dialect) {
      console.error(`Unknown dialect "${options.dialect}". Expected: postgres or sqlite.`);
      process.exitCode = 1;
      return;
    }
    console.log(schemaScript(dialect, options.prefix));
  });

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
