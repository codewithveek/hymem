/**
 * LLM-backed Extractor: session transcript -> durable facts.
 *
 * The prompt and schema are options, because domain customisation almost
 * always lands here — a medical or legal app wants different slots, not a
 * different implementation. Replace the whole thing (rules, regex, an existing
 * structured pipeline) by passing your own `extractor` to createMemory.
 */
import { z } from "zod";
import type { LanguageModel } from "ai";
import type { ExtractedFact, Extractor } from "../core/ports.js";
import type { SessionInput } from "../core/types.js";
import { canonEntity } from "../core/ids.js";
import { object } from "./generate.js";

export const DEFAULT_EXTRACTION_SCHEMA = z.object({
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

export const DEFAULT_EXTRACTION_SYSTEM = `You extract durable memory facts from a chat session between a user and an assistant.
- Reuse the SAME attribute name for the same kind of fact so updates can be detected.
- Extract stated facts, preferences, decisions, and events. Skip small talk, hypotheticals, and assistant boilerplate.
- If the session updates something previously plausible (moving cities, changing jobs), still extract it plainly —
  supersession is handled downstream by attribute matching.
- Prefer fewer, higher-quality facts. An empty list is fine.`;

export interface LlmExtractorOptions {
  system?: string;
  schema?: typeof DEFAULT_EXTRACTION_SCHEMA;
}

export function llmExtractor(model: LanguageModel, options: LlmExtractorOptions = {}): Extractor {
  const system = options.system ?? DEFAULT_EXTRACTION_SYSTEM;
  const schema = options.schema ?? DEFAULT_EXTRACTION_SCHEMA;

  return {
    async extract(session: SessionInput): Promise<ExtractedFact[]> {
      const transcript = session.turns
        .map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`)
        .join("\n");
      const extracted = await object(
        model,
        schema,
        system,
        `Session timestamp: ${session.ts}\n\n${transcript}`,
      );
      // Triples only. Core assigns the id and namespace, and rewrites the
      // speaker token — so this never has to know about tenancy or hashing.
      return extracted.facts.map((extractedFact) => {
        const subject = canonEntity(extractedFact.subject);
        return {
          subject,
          attribute: extractedFact.attribute.trim().toLowerCase(),
          value: extractedFact.value.trim(),
          text: extractedFact.text,
          // The subject is always an entity: recall anchors on it, and
          // extractors routinely list only the *other* named entities.
          entities: [...new Set([subject, ...extractedFact.entities.map(canonEntity)])],
          observedAt: session.ts,
          sessionId: session.id,
        };
      });
    },
  };
}
