/**
 * LongMemEval harness (stub — wire to the real dataset file).
 *
 * Dataset: https://github.com/xiaowu0162/LongMemEval
 * Each instance: { question_id, question_type, question, answer, question_date,
 *                  haystack_session_ids, haystack_dates, haystack_sessions: Turn[][] }
 *
 * Flow per instance:
 *   1. adapt haystack sessions -> SessionInput[]
 *   2. ingestHistory(...)          (NOTE: use a fresh graph per instance, or prefix
 *                                   session/entity ids with the question_id to isolate)
 *   3. answer(question)
 *   4. score: exact/contains match here; swap in an LLM judge or the official
 *      evaluation script for reported numbers.
 */
import { readFileSync, appendFileSync } from "node:fs";
import { ingestHistory } from "./ingest.js";
import { answer, ABSTAIN_ANSWER } from "./answer.js";
import { closeHydra, cypher } from "./hydra.js";
import type { SessionInput } from "./types.js";

interface LmeInstance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date?: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: { role: "user" | "assistant"; content: string }[][];
}

function adapt(inst: LmeInstance): SessionInput[] {
  return inst.haystack_sessions.map((turns, i) => ({
    id: `${inst.question_id}__${inst.haystack_session_ids?.[i] ?? `s${i}`}`,
    ts: new Date(inst.haystack_dates?.[i] ?? Date.now()).toISOString(),
    idx: i,
    turns,
  }));
}

async function wipeGraph() {
  await cypher(`MATCH (n) DETACH DELETE n`); // per-instance isolation; fine for a local dev node
}

function crudeScore(predicted: string, gold: string): boolean {
  const p = predicted.toLowerCase();
  const g = gold.toLowerCase();
  return p.includes(g) || (g === "unknown" && p.includes(ABSTAIN_ANSWER.toLowerCase()));
}

const file = process.argv[2];
const n = Number(process.argv[3] ?? 25);
if (!file) {
  console.log("usage: pnpm eval <longmemeval_s.json> [n]");
  process.exit(0);
}

const instances = (JSON.parse(readFileSync(file, "utf8")) as LmeInstance[]).slice(0, n);
const byType: Record<string, { correct: number; total: number }> = {};
let correct = 0;

for (const [i, inst] of instances.entries()) {
  await wipeGraph();
  await ingestHistory(adapt(inst));
  const a = await answer(inst.question);
  const ok = crudeScore(a.answer, inst.answer);
  correct += ok ? 1 : 0;
  byType[inst.question_type] ??= { correct: 0, total: 0 };
  byType[inst.question_type].total++;
  if (ok) byType[inst.question_type].correct++;
  const line = `${ok ? "PASS" : "FAIL"} [${inst.question_type}] ${inst.question_id}: "${a.answer.slice(0, 120)}" vs gold "${inst.answer}"`;
  console.log(`(${i + 1}/${instances.length}) ${line}`);
  appendFileSync("eval-results.log", line + "\n");
}

console.log(`\nOverall: ${correct}/${instances.length} (${((correct / instances.length) * 100).toFixed(1)}%)`);
for (const [t, s] of Object.entries(byType)) {
  console.log(`  ${t}: ${s.correct}/${s.total}`);
}
await closeHydra();
