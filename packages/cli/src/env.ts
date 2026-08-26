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
import { createMemory, memoryStore, type Memory, type MemoryStore } from "@hymem/core";
import { hydradb, memgraph, neo4jStore } from "@hymem/bolt";

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
 * MEM_STORE: sqlite (default) | postgres | neo4j | memgraph | hydradb | memory.
 * SQLite is the default because it needs nothing installed — node:sqlite is a
 * Node builtin — and unlike "memory" it survives the process.
 *
 * Async because the SQL adapters import their driver on demand: `pg` and
 * `better-sqlite3` are optional here, so someone running against HydraDB never
 * has to install them.
 */
export async function storeFromEnv(): Promise<MemoryStore> {
  const kind = storeKindFromEnv();
  const url = process.env.HYDRA_BOLT_URL ?? process.env.BOLT_URL;
  const token = process.env.HYDRA_TOKEN ?? "local-development-token-32-bytes";
  const user = process.env.BOLT_USER;
  const password = process.env.BOLT_PASSWORD;
  const migrate = (process.env.MEM_MIGRATE ?? "check") as "check" | "auto" | "off";
  const tablePrefix = process.env.MEM_TABLE_PREFIX;

  switch (kind) {
    case "memory":
      return memoryStore();
    case "neo4j":
      return neo4jStore({ url, user, password, token });
    case "memgraph":
      return memgraph({ url, user, password, token });
    case "hydradb":
      return hydradb({ url, token });
    case "postgres": {
      const { postgres } = await import("@hymem/postgres");
      const { Pool } = await import("pg");
      const connectionString = process.env.DATABASE_URL ?? process.env.PG_URL;
      if (!connectionString) {
        throw new Error('MEM_STORE=postgres needs DATABASE_URL (or PG_URL) to be set.');
      }
      return postgres({ client: new Pool({ connectionString }), migrate, tablePrefix });
    }
    case "sqlite": {
      const { sqlite } = await import("@hymem/sqlite");
      const { DatabaseSync } = await import("node:sqlite");
      return sqlite({
        database: new DatabaseSync(sqlitePathFromEnv()),
        migrate,
        tablePrefix,
      });
    }
    default:
      throw new Error(
        `Unknown MEM_STORE "${kind}". Expected: sqlite, postgres, neo4j, memgraph, hydradb, or memory.`,
      );
  }
}

/** Where `storeFromEnv()` will read and write. */
export interface StoreTarget {
  /** MEM_STORE with the default applied — never the raw env var. */
  kind: string;
  /** Where it points: a file path, a URL with credentials stripped, or "in-process". */
  target: string;
  /**
   * True when the store dies with the process, so writing to it destroys
   * nothing. Anything else is somebody's real data until proven otherwise.
   */
  ephemeral: boolean;
}

/**
 * Describe the store WITHOUT building it.
 *
 * This exists so a caller can decide whether an operation is safe before it
 * opens a connection — and so nothing has to restate the defaults that
 * `storeFromEnv` applies. A second copy of "?? sqlite" is a bug waiting to
 * print one store's name while another one is being written to.
 */
export function storeTargetFromEnv(): StoreTarget {
  const kind = storeKindFromEnv();
  switch (kind) {
    case "memory":
      return { kind, target: "in-process", ephemeral: true };
    case "sqlite": {
      const path = sqlitePathFromEnv();
      // ":memory:" is SQLite's own name for a database that never touches disk.
      return { kind, target: path, ephemeral: path === ":memory:" };
    }
    case "postgres":
      return {
        kind,
        target: withoutCredentials(process.env.DATABASE_URL ?? process.env.PG_URL),
        ephemeral: false,
      };
    case "neo4j":
    case "memgraph":
    case "hydradb":
      return {
        kind,
        target: withoutCredentials(process.env.HYDRA_BOLT_URL ?? process.env.BOLT_URL),
        ephemeral: false,
      };
    default:
      // An unknown kind is storeFromEnv's error to raise, not ours to guess at.
      return { kind, target: "unknown", ephemeral: false };
  }
}

const storeKindFromEnv = () => process.env.MEM_STORE ?? "sqlite";
const sqlitePathFromEnv = () => process.env.SQLITE_PATH ?? "hymem.db";

/** A connection string is printable only once the password is out of it. */
function withoutCredentials(connectionString: string | undefined): string {
  if (!connectionString) return "unset";
  try {
    const parsed = new URL(connectionString);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    // Not a URL we can parse — say so rather than risk printing a secret.
    return "(unparseable connection string)";
  }
}

/**
 * The tenant this process works in.
 *
 * Required, with no fallback: an accidentally shared namespace is a data leak,
 * so it has to be a decision. Single-user setups can set MEM_NAMESPACE to
 * anything stable ("local").
 */
export function namespaceFromEnv(): string {
  const namespace = process.env.MEM_NAMESPACE;
  if (!namespace) {
    throw new Error(
      "hymem: MEM_NAMESPACE is not set. It is the tenant boundary — every fact is " +
        'scoped to it. Use a per-user or per-organisation value, or "local" for a ' +
        "single-user setup.",
    );
  }
  return namespace;
}

export async function memoryFromEnv(
  overrides: Partial<Parameters<typeof createMemory>[0]> = {},
): Promise<Memory> {
  return createMemory({
    store: await storeFromEnv(),
    model: modelFromEnv(),
    namespace: namespaceFromEnv(),
    speaker: process.env.MEM_SPEAKER,
    speakerToken: process.env.MEM_SPEAKER_TOKEN,
    maxFacts: Number(process.env.MEM_MAX_FACTS ?? 24),
    abstainThreshold: Number(process.env.MEM_ABSTAIN_THRESHOLD ?? 1),
    ...overrides,
  });
}
