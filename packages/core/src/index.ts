/**
 * hymem — temporal knowledge-graph agent memory, store-agnostic.
 *
 *   import { createMemory } from "@hymem/core";
 *   import { hydradb } from "@hymem/core/stores/cypher";
 *   import { openai } from "@ai-sdk/openai";
 *
 *   const memory = createMemory({
 *     store: hydradb({ url: "bolt://127.0.0.1:7687", token: process.env.HYDRA_TOKEN }),
 *     model: openai("gpt-4o-mini"),
 *   });
 */

// --- the API most callers need ---------------------------------------------
export { createMemory, MissingStageError, ABSTAIN_ANSWER } from "./core/memory.js";
export type { Memory, MemoryOptions } from "./core/memory.js";

// --- ports, for adapter and stage authors ----------------------------------
export type {
  MemoryStore,
  StoreCapabilities,
  Extractor,
  ExtractedFact,
  QueryPlanner,
  Answerer,
} from "./core/ports.js";

// --- domain types -----------------------------------------------------------
export type {
  SessionInput,
  Fact,
  FactStatus,
  StoredFact,
  RetrievedFact,
  SessionRecord,
  SearchQuery,
  QueryLink,
  TemporalMode,
  RecallResult,
  AnswerResult,
} from "./core/types.js";

// --- pure algorithms, usable without an LLM or a createMemory instance ------
export { ingestSession, ingestHistory } from "./core/ingest.js";
export { recall, formatContext } from "./core/recall.js";
export type { RecallOptions } from "./core/recall.js";
export { factId, canonEntity, canonAttribute } from "./core/ids.js";

// --- the store that needs no services --------------------------------------
export { memoryStore } from "./stores/memory-store.js";
