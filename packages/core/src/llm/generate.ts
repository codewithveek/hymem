/**
 * Thin wrappers over the AI SDK. The model is always passed in — hymem never
 * constructs one, never reads an API key, and never depends on a provider
 * package. `ai` is a peer dependency; callers bring their own provider.
 */
import { generateObject, generateText, NoObjectGeneratedError, zodSchema } from "ai";
import type { LanguageModel } from "ai";
import type { z } from "zod";

/** Free-text generation. */
export async function text(model: LanguageModel, system: string, prompt: string): Promise<string> {
  const result = await generateText({ model, system, prompt, temperature: 0 });
  return result.text;
}

const OBJECT_ATTEMPTS = 3;

/**
 * `process` does not exist in every runtime this can be deployed to — edge
 * workers and Deno without the Node compatibility layer among them — and a bare
 * `process.env.X` is a ReferenceError there, not a falsy read. Core is meant to
 * run wherever the caller's store does, so it reads no global without checking.
 */
function isDebugEnabled(): boolean {
  return typeof process !== "undefined" && !!process.env?.HYMEM_DEBUG;
}

/**
 * Schema-validated structured generation.
 *
 * OpenAI-compatible backends without structured outputs (e.g. DashScope/Qwen)
 * only get a bare `json_object` response format: the schema is dropped, and
 * some reject JSON mode unless the word "json" appears in the messages. So
 * spell the schema out in the system prompt — harmless for providers that
 * enforce it natively, decisive for the ones that don't.
 *
 * Such backends also drift now and then (code fences, a wrapper key, a
 * missing field), so: repair the common textual slips, and on a schema miss
 * retry with the validation error fed back — the model is non-deterministic
 * even at temperature 0, and a second attempt almost always lands.
 */
export async function object<T>(
  model: LanguageModel,
  schema: z.ZodType<T>,
  system: string,
  prompt: string,
): Promise<T> {
  const jsonSchema = JSON.stringify(zodSchema(schema).jsonSchema);
  const systemWithSchema = `${system}\n\nRespond with a single JSON object (no prose, no code fences) that matches this JSON schema exactly:\n${jsonSchema}`;
  let feedback = "";
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await generateObject({
        model,
        schema,
        temperature: 0,
        system: systemWithSchema,
        prompt: prompt + feedback,
        repairText: async ({ text }) => repairJsonText(text),
      });
      return result.object as T;
    } catch (error) {
      if (!NoObjectGeneratedError.isInstance(error) || attempt >= OBJECT_ATTEMPTS) throw error;
      const reason =
        error.cause instanceof Error ? error.cause.message : String(error.cause ?? error.message);
      if (isDebugEnabled()) {
        console.error(
          `[llm] attempt ${attempt}/${OBJECT_ATTEMPTS} did not match schema: ${reason.split("\n")[0]}\n  raw: ${(error.text ?? "").slice(0, 400)}`,
        );
      }
      feedback = `\n\n(Your previous reply was:\n${(error.text ?? "").slice(0, 2000)}\nIt was rejected: ${reason.slice(0, 800)}\nReply again with ONLY a JSON object that matches the schema.)`;
    }
  }
}

/**
 * Best-effort cleanup of a model reply that is *almost* JSON: strips code
 * fences and surrounding prose, and unwraps a single-key envelope such as
 * {"result": {...}} / {"output": {...}}. Returns null when nothing applies
 * (the SDK then reports the original error and object() retries).
 */
export function repairJsonText(rawText: string): string | null {
  let candidate = rawText.trim();
  const fencedBlock = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedBlock) candidate = fencedBlock[1].trim();
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) return null;
  candidate = candidate.slice(firstBrace, lastBrace + 1);
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const propertyNames = Object.keys(parsed as object);
      const onlyValue =
        propertyNames.length === 1
          ? (parsed as Record<string, unknown>)[propertyNames[0]]
          : undefined;
      if (
        /^(result|output|response|data|answer|object|json)$/i.test(propertyNames[0] ?? "") &&
        onlyValue &&
        typeof onlyValue === "object" &&
        !Array.isArray(onlyValue)
      ) {
        return JSON.stringify(onlyValue);
      }
    }
  } catch {
    return null;
  }
  return candidate === rawText ? null : candidate;
}
