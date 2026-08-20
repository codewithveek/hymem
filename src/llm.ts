/**
 * LLM access via the Vercel AI SDK — provider-agnostic.
 * Pick a provider with LLM_PROVIDER: openai | anthropic | google | openai-compatible.
 * "openai-compatible" + LLM_BASE_URL covers OpenRouter, Groq, Ollama, LM Studio, vLLM, etc.
 */
import { generateText, generateObject } from "ai";
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
  const r = await generateObject({ model: model(), schema, system, prompt, temperature: 0 });
  return r.object as T;
}
