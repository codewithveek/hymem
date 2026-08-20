import { chat } from "./llm.js";
import { recall } from "./retrieve.js";

export const ABSTAIN_ANSWER = "I don't know based on the conversation history.";

const SYSTEM = `You answer questions about a user's past conversations using ONLY the provided memory facts.
Facts are chronologically ordered and annotated: "(previously: ...)" marks values that were later overwritten,
and "[SUPERSEDED — no longer current]" marks facts that are themselves outdated.
Rules:
- Never use outside knowledge. If the facts do not contain the answer, reply exactly: "${ABSTAIN_ANSWER}"
- For current-state questions, use the newest non-superseded value.
- For questions about the past or about changes, use the supersession annotations and timestamps.
- Be concise. Mention the relevant session date when it helps.`;

export async function answer(question: string): Promise<{ answer: string; abstained: boolean; contextBlock: string }> {
  const r = await recall(question);

  // Structural abstention: no supporting facts → refuse *before* the LLM can guess.
  if (r.abstained) {
    return { answer: ABSTAIN_ANSWER, abstained: true, contextBlock: r.contextBlock };
  }

  const reply = await chat(SYSTEM, `Memory facts:\n${r.contextBlock}\n\nQuestion: ${question}`);
  return { answer: reply.trim(), abstained: false, contextBlock: r.contextBlock };
}
