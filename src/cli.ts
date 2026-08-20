import { readFileSync } from "node:fs";
import { ingestHistory } from "./ingest.js";
import { answer } from "./answer.js";
import { cypher, closeHydra } from "./hydra.js";
import type { SessionInput } from "./types.js";

const [cmd, ...rest] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "ingest": {
      // Expects a JSON file: SessionInput[]  (adapt LongMemEval instances with src/eval.ts helpers)
      const file = rest[0];
      if (!file) throw new Error("usage: pnpm ingest <sessions.json>");
      const sessions = JSON.parse(readFileSync(file, "utf8")) as SessionInput[];
      const n = await ingestHistory(sessions);
      console.log(`Done: ${sessions.length} sessions, ${n} facts.`);
      break;
    }
    case "ask": {
      const question = rest.join(" ");
      if (!question) throw new Error('usage: pnpm ask "your question"');
      const a = await answer(question);
      console.log(a.answer);
      if (!a.abstained) console.log(`\n--- supporting facts ---\n${a.contextBlock}`);
      break;
    }
    case "inspect": {
      const entity = rest[0]?.toLowerCase();
      const rows = await cypher<{ text: string; status: string; observed_at: string; session_id: string }>(
        entity
          ? `MATCH (f:Fact)-[:ABOUT]->(:Entity {name: $entity})
             OPTIONAL MATCH (f)-[:STATED_IN]->(s:Session)
             RETURN f.text AS text, f.status AS status, f.observed_at AS observed_at, s.id AS session_id
             ORDER BY observed_at`
          : `MATCH (f:Fact) OPTIONAL MATCH (f)-[:STATED_IN]->(s:Session)
             RETURN f.text AS text, f.status AS status, f.observed_at AS observed_at, s.id AS session_id
             ORDER BY observed_at`,
        { entity },
      );
      for (const r of rows) console.log(`[${r.status}] ${r.observed_at} · ${r.text}  (session ${r.session_id})`);
      console.log(`\n${rows.length} fact(s).`);
      break;
    }
    default:
      console.log("commands: ingest <sessions.json> | ask <question> | inspect [entity]");
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => closeHydra());
