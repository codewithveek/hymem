/**
 * LLM-backed Answerer: question + retrieved context -> prose.
 *
 * Optional by design. Agent authors usually want `memory.recall()` and inject
 * the contextBlock into their own prompt; this exists for the CLI, the MCP
 * server, and the eval harness.
 */
import type { LanguageModel } from "ai";
import type { Answerer } from "../core/ports.js";
import { text } from "./generate.js";

export const ABSTAIN_ANSWER = "I don't know based on the conversation history.";

export const DEFAULT_ANSWER_SYSTEM = `You answer questions about a user's past conversations using ONLY the provided memory facts.
Facts are chronologically ordered and annotated: "(previously: ...)" marks values that were later overwritten,
and "[SUPERSEDED — no longer current]" marks facts that are themselves outdated.
Rules:
- Never use outside knowledge. If the facts do not contain the answer, reply exactly: "${ABSTAIN_ANSWER}"
- For current-state questions, use the newest non-superseded value.
- For questions about the past or about changes, use the supersession annotations and timestamps.
- Be concise. Mention the relevant session date when it helps.`;

export interface LlmAnswererOptions {
  system?: string;
}

export function llmAnswerer(model: LanguageModel, options: LlmAnswererOptions = {}): Answerer {
  const system = options.system ?? DEFAULT_ANSWER_SYSTEM;
  return {
    async answer(question: string, context: string): Promise<string> {
      const reply = await text(model, system, `Memory facts:\n${context}\n\nQuestion: ${question}`);
      return reply.trim();
    },
  };
}
