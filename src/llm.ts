/**
 * LLM access via the Vercel AI SDK — provider-agnostic.
 * Pick a provider with LLM_PROVIDER: openai | anthropic | google | openai-compatible.
 * "openai-compatible" + LLM_BASE_URL covers OpenRouter, Groq, Ollama, LM Studio, vLLM, etc.
 */
import { generateText, generateObject, zodSchema, NoObjectGeneratedError } from "ai";
import type { LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { z } from "zod";
import { config } from "./config.js";

let cached: LanguageModel | null = null;

export function model(): LanguageModel {
  if (cached) return cached;
  const { llmProvider, llmModel, llmApiKey, llmBaseUrl } = config;
  switch (llmProvider) {
    case "openai":
      cached = createOpenAI({ apiKey: llmApiKey })(llmModel);
      break;
    case "anthropic":
      cached = createAnthropic({ apiKey: llmApiKey })(llmModel);
      break;
    case "google":
      cached = createGoogleGenerativeAI({ apiKey: llmApiKey })(llmModel);
      break;
    default:
      cached = createOpenAICompatible({
        name: llmProvider || "openai-compatible",
        apiKey: llmApiKey,
        baseURL: llmBaseUrl,
      })(llmModel);
  }
  return cached;
}

/** Free-text generation. */
export async function text(system: string, prompt: string): Promise<string> {
  const r = await generateText({ model: model(), system, prompt, temperature: 0 });
  return r.text;
}

/**
 * Schema-validated structured generation. The AI SDK handles JSON mode,
 * parsing, and validation against the zod schema — no manual fence-stripping.
 */
export async function object<T>(schema: z.ZodType<T>, system: string, prompt: string): Promise<T> {
  // OpenAI-compatible backends without structured outputs (e.g. DashScope/Qwen)
  // only get a bare `json_object` response format: the schema is dropped, and
  // some reject JSON mode unless the word "json" appears in the messages. So
  // spell the schema out in the system prompt — harmless for providers that
  // enforce it natively, decisive for the ones that don't.
  //
  // Such backends also drift now and then (code fences, a wrapper key, a
  // missing field), so: repair the common textual slips, and on a schema miss
  // retry with the validation error fed back — the model is non-deterministic
  // even at temperature 0, and a second attempt almost always lands.
  const jsonSchema = JSON.stringify(zodSchema(schema).jsonSchema);
  const sys = `${system}\n\nRespond with a single JSON object (no prose, no code fences) that matches this JSON schema exactly:\n${jsonSchema}`;
  let feedback = "";
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await generateObject({
        model: model(), schema, temperature: 0,
        system: sys,
        prompt: prompt + feedback,
        repairText: async ({ text }) => repairJsonText(text),
      });
      return r.object as T;
    } catch (e) {
      if (!NoObjectGeneratedError.isInstance(e) || attempt >= OBJECT_ATTEMPTS) throw e;
      const reason = e.cause instanceof Error ? e.cause.message : String(e.cause ?? e.message);
      if (process.env.HYDRA_DEBUG) {
        console.error(`[llm] attempt ${attempt}/${OBJECT_ATTEMPTS} did not match schema: ${reason.split("\n")[0]}\n  raw: ${(e.text ?? "").slice(0, 400)}`);
      }
      feedback = `\n\n(Your previous reply was:\n${(e.text ?? "").slice(0, 2000)}\nIt was rejected: ${reason.slice(0, 800)}\nReply again with ONLY a JSON object that matches the schema.)`;
    }
  }
}

const OBJECT_ATTEMPTS = 3;

/**
 * Best-effort cleanup of a model reply that is *almost* JSON: strips code
 * fences and surrounding prose, and unwraps a single-key envelope such as
 * {"result": {...}} / {"output": {...}}. Returns null when nothing applies
 * (the SDK then reports the original error and object() retries).
 */
export function repairJsonText(text: string): string | null {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  s = s.slice(start, end + 1);
  try {
    const parsed = JSON.parse(s) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed as object);
      const inner = keys.length === 1 ? (parsed as Record<string, unknown>)[keys[0]] : undefined;
      if (/^(result|output|response|data|answer|object|json)$/i.test(keys[0] ?? "") && inner && typeof inner === "object" && !Array.isArray(inner)) {
        return JSON.stringify(inner);
      }
    }
  } catch {
    return null;
  }
  return s === text ? null : s;
}
