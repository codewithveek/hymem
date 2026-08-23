/**
 * createMemory — the public API.
 *
 * Everything is injected: no globals, no environment reads, no provider
 * packages. Two memories with different stores can coexist in one process,
 * and every stage is replaceable.
 *
 * This module imports the LLM defaults statically, so `ai` is a required peer
 * dependency of anyone calling createMemory(). Code that wants no LLM
 * dependency at all can drive the pure algorithms directly — `ingestSession`
 * and `recall` in this directory take a store and plain data, and import
 * nothing.
 */
import type { LanguageModel } from "ai";
import type { Answerer, Extractor, MemoryStore, QueryPlanner } from "./ports.js";
import type {
  AnswerResult, Fact, RecallResult, SessionInput, StoredFact,
} from "./types.js";
import { ingestHistory, ingestSession } from "./ingest.js";
import { llmAnswerer, llmExtractor, llmPlanner } from "../llm/index.js";
import { recall as runRecall } from "./recall.js";
import { canonEntity } from "./ids.js";

export interface MemoryOptions {
  /** Where facts live. Required — there is no default store. */
  store: MemoryStore;

  /**
   * Convenience: fills extractor, planner and answerer with LLM-backed
   * defaults. Any of the three can be overridden individually below.
   */
  model?: LanguageModel;

  /** Session transcript -> facts. Defaults to llmExtractor(model). */
  extractor?: Extractor;
  /** Question -> lookup keys. Defaults to llmPlanner(model). */
  planner?: QueryPlanner;
  /**
   * Retrieved context -> prose. Defaults to llmAnswerer(model).
   * Pass null to build a recall-only memory; `ask()` then throws.
   */
  answerer?: Answerer | null;

  /** Upper bound on facts pulled into a recall. Default 24. */
  maxFacts?: number;
  /** Recall abstains below this many supporting facts. Default 1. */
  abstainThreshold?: number;
}

export interface Memory {
  /** The store, for adapter-specific escapes. */
  readonly store: MemoryStore;

  /** Extract and persist facts from one session. */
  remember(session: SessionInput, previousSessionId?: string): Promise<Fact[]>;
  /** Ingest a whole history in chronological order. Returns the fact count. */
  rememberAll(
    sessions: SessionInput[],
    onProgress?: (session: SessionInput, facts: Fact[]) => void,
  ): Promise<number>;

  /** Retrieve supporting facts and a prompt-ready context block. No LLM synthesis. */
  recall(question: string): Promise<RecallResult>;
  /** Retrieve, then answer in prose. Abstains structurally when unsupported. */
  ask(question: string): Promise<AnswerResult>;

  /** Every stored fact, optionally narrowed to one entity. */
  facts(entity?: string): Promise<StoredFact[]>;
  /** Delete facts by id. */
  forget(ids: string[]): Promise<void>;
  /** Wipe everything this memory owns. */
  clear(): Promise<void>;
  /** Release the store's connections. */
  close(): Promise<void>;
}

/** Thrown when a stage is needed but was never configured. */
export class MissingStageError extends Error {
  constructor(stage: string, hint: string) {
    super(`hymem: no ${stage} configured. ${hint}`);
    this.name = "MissingStageError";
  }
}

export const ABSTAIN_ANSWER = "I don't know based on the conversation history.";

export function createMemory(options: MemoryOptions): Memory {
  const { store, model } = options;
  const maxFacts = options.maxFacts ?? 24;
  const abstainThreshold = options.abstainThreshold ?? 1;

  // Stages are resolved lazily so that constructing a recall-only memory
  // never requires an extraction model, and vice versa.
  let resolvedExtractor = options.extractor;
  let resolvedPlanner = options.planner;
  let resolvedAnswerer = options.answerer;

  const requireExtractor = (): Extractor => {
    if (resolvedExtractor) return resolvedExtractor;
    if (!model) {
      throw new MissingStageError("extractor", "Pass `model` or an `extractor` to createMemory().");
    }
    return (resolvedExtractor = llmExtractor(model));
  };

  const requirePlanner = (): QueryPlanner => {
    if (resolvedPlanner) return resolvedPlanner;
    if (!model) {
      throw new MissingStageError("planner", "Pass `model` or a `planner` to createMemory().");
    }
    return (resolvedPlanner = llmPlanner(model));
  };

  const requireAnswerer = (): Answerer => {
    if (resolvedAnswerer) return resolvedAnswerer;
    if (resolvedAnswerer === null) {
      throw new MissingStageError(
        "answerer",
        "This memory was built with `answerer: null`. Use recall() instead of ask().",
      );
    }
    if (!model) {
      throw new MissingStageError("answerer", "Pass `model` or an `answerer` to createMemory().");
    }
    return (resolvedAnswerer = llmAnswerer(model));
  };

  return {
    store,

    async remember(session, previousSessionId) {
      const facts = await requireExtractor().extract(session);
      return ingestSession(store, facts, session, previousSessionId);
    },

    rememberAll(sessions, onProgress) {
      const extractor = requireExtractor();
      return ingestHistory(store, (session) => extractor.extract(session), sessions, onProgress);
    },

    async recall(question) {
      const link = await requirePlanner().plan(question);
      return runRecall(store, link, { maxFacts, abstainThreshold });
    },

    async ask(question) {
      const answerer = requireAnswerer(); // fail fast, before spending a plan call
      const recalled = await this.recall(question);
      // Structural abstention: no supporting facts -> refuse *before* the LLM can guess.
      if (recalled.abstained) {
        return { answer: ABSTAIN_ANSWER, abstained: true, contextBlock: recalled.contextBlock };
      }
      return {
        answer: await answerer.answer(question, recalled.contextBlock),
        abstained: false,
        contextBlock: recalled.contextBlock,
      };
    },

    facts: (entity) => store.listFacts(entity ? canonEntity(entity) : undefined),
    forget: (ids) => store.deleteFacts(ids),
    clear: () => store.clear(),
    close: () => store.close(),
  };
}

