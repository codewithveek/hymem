/**
 * LLM-backed QueryPlanner: question -> store lookup keys.
 *
 * This is the read-path counterpart to the extractor. It decides which
 * entities to anchor on, which attribute slots are plausible, and how the
 * question relates to the timeline.
 */
import { z } from "zod";
import type { LanguageModel } from "ai";
import type { QueryPlanner } from "../core/ports.js";
import type { QueryLink } from "../core/types.js";
import { object } from "./generate.js";

export const DEFAULT_LINK_SCHEMA = z.object({
  entities: z.array(z.string()).describe('Lowercase canonical entity names likely to appear; "user" almost always belongs here'),
  attributes: z.array(z.string()).describe("Likely snake_case fact slots (home_city, job_title, ...); empty = no filter"),
  temporal: z.enum(["current", "point_in_time", "history"]).describe(
    '"current" for present-state questions, "point_in_time" for as-of-a-date questions, "history" for before/after/change questions',
  ),
  at: z.string().nullable().describe('ISO timestamp when temporal is "point_in_time", else null'),
});

export const DEFAULT_LINK_SYSTEM = "You map a question about a user's chat history to graph lookup keys.";

export interface LlmPlannerOptions {
  system?: string;
  schema?: typeof DEFAULT_LINK_SCHEMA;
}

export function llmPlanner(model: LanguageModel, options: LlmPlannerOptions = {}): QueryPlanner {
  const system = options.system ?? DEFAULT_LINK_SYSTEM;
  const schema = options.schema ?? DEFAULT_LINK_SCHEMA;
  return {
    async plan(question: string): Promise<QueryLink> {
      const planned = await object(model, schema, system, question);
      return {
        entities: planned.entities ?? [],
        attributes: planned.attributes ?? [],
        temporal: planned.temporal,
        at: planned.at ?? null,
      };
    },
  };
}
