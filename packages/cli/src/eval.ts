/**
 * LongMemEval harness (stub — wire to the real dataset file).
 *
 * Dataset: https://github.com/xiaowu0162/LongMemEval
 * Each instance: { question_id, question_type, question, answer, question_date,
 *                  haystack_session_ids, haystack_dates, haystack_sessions: Turn[][] }
 *
 * Flow per instance:
 *   1. adapt haystack sessions -> SessionInput[]
 *   2. memory.rememberAll(...)    (the graph is wiped per instance to isolate)
 *   3. memory.ask(question)
 *   4. score: exact/contains match here; swap in an LLM judge or the official
 *      evaluation script for reported numbers.
 */
import { readFileSync, appendFileSync } from "node:fs";
import { memoryFromEnv } from "./env.js";
import { ABSTAIN_ANSWER } from "@hymem/core";
import type { SessionInput } from "@hymem/core";

interface LongMemEvalInstance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date?: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: { role: "user" | "assistant"; content: string }[][];
}

function adapt(instance: LongMemEvalInstance): SessionInput[] {
  return instance.haystack_sessions.map((turns, index) => ({
    id: `${instance.question_id}__${instance.haystack_session_ids?.[index] ?? `s${index}`}`,
    ts: new Date(instance.haystack_dates?.[index] ?? Date.now()).toISOString(),
    idx: index,
    turns,
  }));
}

function crudeScore(predicted: string, gold: string): boolean {
  const predictedLower = predicted.toLowerCase();
  const goldLower = gold.toLowerCase();
  return (
    predictedLower.includes(goldLower) ||
    (goldLower === "unknown" && predictedLower.includes(ABSTAIN_ANSWER.toLowerCase()))
  );
}

const file = process.argv[2];
const instanceLimit = Number(process.argv[3] ?? 25);
if (!file) {
  console.log("usage: npm run eval <longmemeval_s.json> [n]");
  process.exit(0);
}

const memory = await memoryFromEnv();
const instances = (JSON.parse(readFileSync(file, "utf8")) as LongMemEvalInstance[]).slice(
  0,
  instanceLimit,
);
const scoreByType: Record<string, { correct: number; total: number }> = {};
let correctCount = 0;

for (const [index, instance] of instances.entries()) {
  // Per-instance isolation, so haystacks cannot leak into one another.
  await memory.clear();
  await memory.rememberAll(adapt(instance));
  const answered = await memory.ask(instance.question);
  const isCorrect = crudeScore(answered.answer, instance.answer);
  correctCount += isCorrect ? 1 : 0;
  scoreByType[instance.question_type] ??= { correct: 0, total: 0 };
  scoreByType[instance.question_type].total++;
  if (isCorrect) scoreByType[instance.question_type].correct++;
  const line = `${isCorrect ? "PASS" : "FAIL"} [${instance.question_type}] ${instance.question_id}: "${answered.answer.slice(0, 120)}" vs gold "${instance.answer}"`;
  console.log(`(${index + 1}/${instances.length}) ${line}`);
  appendFileSync("eval-results.log", line + "\n");
}

console.log(
  `\nOverall: ${correctCount}/${instances.length} (${((correctCount / instances.length) * 100).toFixed(1)}%)`,
);
for (const [questionType, score] of Object.entries(scoreByType)) {
  console.log(`  ${questionType}: ${score.correct}/${score.total}`);
}
await memory.close();
