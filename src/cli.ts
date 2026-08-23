#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { memoryFromEnv } from "./env.js";
import { runStoreConformance, CONFORMANCE_TEST_COUNT } from "./testing/conformance.js";
import { storeFromEnv } from "./env.js";
import type { SessionInput } from "./core/types.js";

const memory = await memoryFromEnv();

const program = new Command();

program
  .name("hymem")
  .description("Temporal knowledge-graph agent memory — store-agnostic")
  .version("0.2.0")
  .hook("postAction", async () => {
    await memory.close();
  });

program
  .command("ingest")
  .description("Ingest a JSON file of sessions into memory")
  .argument("<file>", "path to a SessionInput[] JSON file")
  .action(async (file: string) => {
    const sessions = JSON.parse(readFileSync(file, "utf8")) as SessionInput[];
    const factCount = await memory.rememberAll(sessions, (session, facts) => {
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
    const answered = await memory.ask(parts.join(" "));
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
    const recalled = await memory.recall(parts.join(" "));
    if (options.json) console.log(JSON.stringify(recalled.facts, null, 2));
    else console.log(recalled.abstained ? "Not in memory." : recalled.contextBlock);
  });

program
  .command("inspect")
  .description("List stored facts, optionally filtered by entity")
  .argument("[entity]", "entity name filter, e.g. user")
  .option("--json", "output as JSON")
  .action(async (entity: string | undefined, options: { json?: boolean }) => {
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
    console.log(`\n${facts.length} fact(s).`);
  });

program
  .command("forget")
  .description("Delete facts by id (ids from `hymem inspect`)")
  .argument("<ids...>", "fact ids")
  .action(async (ids: string[]) => {
    await memory.forget(ids);
    console.log(`Deleted ${ids.length} fact(s).`);
  });

program
  .command("conformance")
  .description("Verify the configured store against the MemoryStore contract")
  .action(async () => {
    const store = await storeFromEnv();
    console.log(`Running ${CONFORMANCE_TEST_COUNT} conformance tests against ${process.env.MEM_STORE ?? "hydradb"}:\n`);
    const result = await runStoreConformance(() => store, { verbose: true });
    console.log(
      `\n${result.passed} passed, ${result.failed.length} failed, ${result.skipped.length} skipped`,
    );
    await store.close();
    if (result.failed.length > 0) process.exitCode = 1;
  });

program
  .command("schema")
  .description("Print the SQL DDL for a store, to apply through your own migration tool")
  .option("--dialect <name>", "postgres | sqlite", "postgres")
  .option("--prefix <prefix>", "table-name prefix", "hymem_")
  .action(async (options: { dialect: string; prefix: string }) => {
    const { schemaScript, POSTGRES, SQLITE } = await import("./stores/sql/index.js");
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
