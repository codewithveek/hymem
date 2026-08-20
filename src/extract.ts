import { createHash } from "node:crypto";
import { chatJson } from "./llm.js";
import type { Fact, SessionInput } from "./types.js";

const SYSTEM = `You extract durable memory facts from a chat session between a user and an assistant.

Return JSON: {"facts": [{"subject": string, "attribute": string, "value": string, "text": string, "entities": string[]}]}

Rules:
- subject: canonical entity the fact is about. The human speaker is always "user".
- attribute: a stable snake_case slot name (home_city, job_title, dog_name, dietary_restriction, ...).
  Reuse the SAME attribute name for the same kind of fact so updates can be detected.
- value: the concrete value as a short string.
- text: one self-contained natural-language sentence stating the fact.
- entities: every named entity involved, lowercase canonical form ("user" included when relevant).
- Extract stated facts, preferences, decisions, and events. Skip small talk, hypotheticals, and assistant boilerplate.
- If the session updates something previously plausible (moving cities, changing jobs), still extract it plainly —
  supersession is handled downstream by attribute matching.
- Prefer fewer, higher-quality facts. Empty list is fine.`;

export function factId(subject: string, attribute: string, value: string): string {
  return createHash("sha256").update(`${subject}|${attribute}|${value}`.toLowerCase()).digest("hex").slice(0, 24);
}

export function canonEntity(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function extractFacts(session: SessionInput): Promise<Fact[]> {
  const transcript = session.turns.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join("\n");
  const out = await chatJson<{ facts: Omit<Fact, "id" | "observedAt" | "sessionId">[] }>(
    SYSTEM,
    `Session timestamp: ${session.ts}\n\n${transcript}`,
  );
  return (out.facts ?? []).map((f) => ({
    ...f,
    subject: canonEntity(f.subject),
    attribute: f.attribute.trim().toLowerCase(),
    value: String(f.value).trim(),
    entities: [...new Set((f.entities ?? []).map(canonEntity))],
    id: factId(f.subject, f.attribute, String(f.value)),
    observedAt: session.ts,
    sessionId: session.id,
  }));
}
