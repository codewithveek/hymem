import { createHash } from "node:crypto";
import { z } from "zod";
import { object } from "./llm.js";
import type { Fact, SessionInput } from "./types.js";

const ExtractionSchema = z.object({
  facts: z.array(
    z.object({
      subject: z.string().describe('Canonical entity the fact is about; the human speaker is always "user"'),
      attribute: z.string().describe("Stable snake_case slot name (home_city, job_title, dietary_restriction, ...)"),
      value: z.string().describe("The concrete value, short"),
      text: z.string().describe("One self-contained sentence stating the fact"),
      entities: z.array(z.string()).describe("Every named entity involved, lowercase canonical form"),
    }),
  ),
});

const SYSTEM = `You extract durable memory facts from a chat session between a user and an assistant.
- Reuse the SAME attribute name for the same kind of fact so updates can be detected.
- Extract stated facts, preferences, decisions, and events. Skip small talk, hypotheticals, and assistant boilerplate.
- If the session updates something previously plausible (moving cities, changing jobs), still extract it plainly —
  supersession is handled downstream by attribute matching.
- Prefer fewer, higher-quality facts. An empty list is fine.`;

export function factId(subject: string, attribute: string, value: string): string {
  return createHash("sha256").update(`${subject}|${attribute}|${value}`.toLowerCase()).digest("hex").slice(0, 24);
}

export function canonEntity(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function extractFacts(session: SessionInput): Promise<Fact[]> {
  const transcript = session.turns.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join("\n");
  const out = await object(ExtractionSchema, SYSTEM, `Session timestamp: ${session.ts}\n\n${transcript}`);
  return out.facts.map((f) => ({
    ...f,
    subject: canonEntity(f.subject),
    attribute: f.attribute.trim().toLowerCase(),
    value: f.value.trim(),
    entities: [...new Set(f.entities.map(canonEntity))],
    id: factId(f.subject, f.attribute, f.value),
    observedAt: session.ts,
    sessionId: session.id,
  }));
}
