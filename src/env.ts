/**
 * Environment-driven construction, for the shipped executables (CLI, MCP
 * server, eval harness).
 *
 * This is the ONLY module that reads process.env or imports a provider
 * package. The library itself takes a store and a model as arguments; when the
 * packages are split this file belongs to @hymem/cli, not to the core.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { createMemory, type Memory } from "./core/memory.js";
import { memoryStore } from "./stores/memory-store.js";
import { hydradb, memgraph, neo4j } from "./stores/cypher/index.js";
import type { MemoryStore } from "./core/ports.js";

try {
  process.loadEnvFile(".env"); // Node >= 20.12; real env vars still win
} catch {
  /* no .env file — variables may come from the shell, CI, or Docker */
}

/**
 * Build the configured model.
 *
 * LLM_PROVIDER: openai | anthropic | google | openai-compatible (default).
 * "openai-compatible" + LLM_BASE_URL covers OpenRouter, Groq, Ollama,
 * LM Studio, vLLM, DashScope, and anything else speaking that dialect.
 */
export function modelFromEnv(): LanguageModel {
  const provider = process.env.LLM_PROVIDER ?? "openai";
  const modelName = process.env.LLM_MODEL ?? "gpt-4o-mini";
  const apiKey = process.env.LLM_API_KEY ?? "";
  const baseURL = process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";

  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey })(modelName);
    case "anthropic":
      return createAnthropic({ apiKey })(modelName);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelName);
    default:
      return createOpenAICompatible({ name: provider || "openai-compatible", apiKey, baseURL })(
        modelName,
      );
  }
}

/**
 * Build the configured store.
 *
 * MEM_STORE: hydradb (default) | neo4j | memgraph | memory.
 * "memory" needs no services at all, which makes it the right default for
 * trying the CLI before standing anything up.
 */
export function storeFromEnv(): MemoryStore {
  const kind = process.env.MEM_STORE ?? "hydradb";
  const url = process.env.HYDRA_BOLT_URL ?? process.env.BOLT_URL;
  const token = process.env.HYDRA_TOKEN ?? "local-development-token-32-bytes";
  const user = process.env.BOLT_USER;
  const password = process.env.BOLT_PASSWORD;

  switch (kind) {
    case "memory":
      return memoryStore();
    case "neo4j":
      return neo4j({ url, user, password, token });
    case "memgraph":
      return memgraph({ url, user, password, token });
    case "hydradb":
      return hydradb({ url, token });
    default:
      throw new Error(
        `Unknown MEM_STORE "${kind}". Expected: hydradb, neo4j, memgraph, or memory.`,
      );
  }
}

export function memoryFromEnv(overrides: Partial<Parameters<typeof createMemory>[0]> = {}): Memory {
  return createMemory({
    store: storeFromEnv(),
    model: modelFromEnv(),
    maxFacts: Number(process.env.MEM_MAX_FACTS ?? 24),
    abstainThreshold: Number(process.env.MEM_ABSTAIN_THRESHOLD ?? 1),
    ...overrides,
  });
}
