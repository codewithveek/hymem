#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { ingestHistory } from "./ingest.js";
import { answer } from "./answer.js";
import { recall } from "./retrieve.js";
import { cypher, closeHydra } from "./hydra.js";
import type { SessionInput } from "./types.js";

const program = new Command();

program
  .name("hymem")
  .description("Temporal knowledge-graph agent memory on the HydraDB OSS engine")
  .version("0.1.0")
  .hook("postAction", async () => { await closeHydra(); });

program
  .command("ingest")
  .description("Ingest a JSON file of sessions into memory")
  .argument("<file>", "path to a SessionInput[] JSON file")
  .action(async (file: string) => {
    const sessions = JSON.parse(readFileSync(file, "utf8")) as SessionInput[];
    const n = await ingestHistory(sessions);
    console.log(`Done: ${sessions.length} sessions, ${n} facts.`);
  });

program
  .command("ask")
  .description("Ask a question against memory (abstains when unsupported)")
  .argument("<question...>", "natural-language question")
  .option("--facts", "also print the supporting facts")
  .action(async (parts: string[], opts: { facts?: boolean }) => {
    const a = await answer(parts.join(" "));
    console.log(a.answer);
    if (opts.facts && !a.abstained) console.log(`\n--- supporting facts ---\n${a.contextBlock}`);
  });

program
  .command("recall")
  .description("Raw recall: print matching facts without LLM synthesis")
  .argument("<question...>", "natural-language question")
  .option("--json", "output as JSON")
  .action(async (parts: string[], opts: { json?: boolean }) => {
    const r = await recall(parts.join(" "));
    if (opts.json) console.log(JSON.stringify(r.facts, null, 2));
    else console.log(r.abstained ? "Not in memory." : r.contextBlock);
  });

program
  .command("inspect")
  .description("List stored facts, optionally filtered by entity")
  .argument("[entity]", "entity name filter, e.g. user")
  .option("--json", "output as JSON")
  .action(async (entity: string | undefined, opts: { json?: boolean }) => {
    const rows = await cypher<{ id: string; text: string; status: string; observed_at: string; session_id: string }>(
      entity
        ? `MATCH (f:Fact)-[:ABOUT]->(:Entity {name: $entity})
           OPTIONAL MATCH (f)-[:STATED_IN]->(s:Session)
           RETURN f.id AS id, f.text AS text, f.status AS status, f.observed_at AS observed_at, s.id AS session_id
           ORDER BY observed_at`
        : `MATCH (f:Fact) OPTIONAL MATCH (f)-[:STATED_IN]->(s:Session)
           RETURN f.id AS id, f.text AS text, f.status AS status, f.observed_at AS observed_at, s.id AS session_id
           ORDER BY observed_at`,
      { entity: entity?.toLowerCase() },
    );
    if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    for (const r of rows) console.log(`[${r.status}] ${r.observed_at} · ${r.text}  (id ${r.id}, session ${r.session_id})`);
    console.log(`\n${rows.length} fact(s).`);
  });

program
  .command("forget")
  .description("Delete facts by id (ids from `hymem inspect`)")
  .argument("<ids...>", "fact ids")
  .action(async (ids: string[]) => {
    await cypher(`UNWIND $ids AS fid MATCH (f:Fact {id: fid}) DETACH DELETE f`, { ids });
    console.log(`Deleted ${ids.length} fact(s).`);
  });

program.parseAsync().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
