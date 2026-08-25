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
import { identifyFacts, ingestHistory, ingestSession } from "./ingest.js";
import { llmAnswerer, llmExtractor, llmPlanner } from "../llm/index.js";
import { recall as runRecall } from "./recall.js";
import { canonEntity } from "./ids.js";

export interface MemoryOptions {
  /** Where facts live. Required — there is no default store. */
  store: MemoryStore;

  /**
   * Tenant boundary. Required, with no default: an accidental shared namespace
   * is a data leak, so it has to be a decision rather than an omission.
   *
   * One namespace per end user gives isolated per-user memory. One namespace
   * per organisation gives shared team memory — and then each session needs a
   * `speaker`, or everyone collides on the same subject.
   */
  namespace: string;

  /**
   * Default identity for the human, when this memory serves one person.
   * Per-session `speaker` overrides it, which is what a shared namespace needs.
   */
  speaker?: string;

  /**
   * Placeholder the extractor and planner use for "the human speaking".
   * Default "user". Change it if your domain talks about users literally —
   * "the user clicked export" would otherwise be rewritten into a fact about
   * the speaker. Custom extractors must agree on the token.
   */
  speakerToken?: string;

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

  /** The namespace every operation on this memory is scoped to. */
  readonly namespace: string;

  /** Extract and persist facts from one session. */
  remember(session: SessionInput, previousSessionId?: string): Promise<Fact[]>;
  /** Ingest a whole history in chronological order. Returns the fact count. */
  rememberAll(
    sessions: SessionInput[],
    onProgress?: (session: SessionInput, facts: Fact[]) => void,
  ): Promise<number>;

  /** Retrieve supporting facts and a prompt-ready context block. No LLM synthesis. */
  recall(question: string, options?: { speaker?: string }): Promise<RecallResult>;
  /** Retrieve, then answer in prose. Abstains structurally when unsupported. */
  ask(question: string, options?: { speaker?: string }): Promise<AnswerResult>;

  /** Every stored fact, optionally narrowed to one entity. */
  facts(entity?: string): Promise<StoredFact[]>;
  /** Delete facts by id. */
  forget(ids: string[]): Promise<void>;
  /** Wipe this namespace. Other namespaces in the same store are untouched. */
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
  const { store, model, namespace } = options;
  if (!namespace) {
    throw new Error("hymem: createMemory() requires a `namespace`. It is the tenant boundary.");
  }
  const maxFacts = options.maxFacts ?? 24;
  const abstainThreshold = options.abstainThreshold ?? 1;
  const { speakerToken } = options;
  const ingestOptions = { namespace, speakerToken };

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

  const identify = (extracted: Awaited<ReturnType<Extractor["extract"]>>, session: SessionInput) =>
    identifyFacts(extracted, session, ingestOptions);

  return {
    store,
    namespace,

    async remember(session, previousSessionId) {
      const withSpeaker = { ...session, speaker: session.speaker ?? options.speaker };
      const extracted = await requireExtractor().extract(withSpeaker);
      return ingestSession(
        store,
        identify(extracted, withSpeaker),
        withSpeaker,
        ingestOptions,
        previousSessionId,
      );
    },

    rememberAll(sessions, onProgress) {
      const extractor = requireExtractor();
      return ingestHistory(
        store,
        async (session) => identify(await extractor.extract(session), session),
        sessions.map((session) => ({ ...session, speaker: session.speaker ?? options.speaker })),
        ingestOptions,
        onProgress,
      );
    },

    async recall(question, recallOptions) {
      const link = await requirePlanner().plan(question);
      return runRecall(store, link, {
        namespace,
        maxFacts,
        abstainThreshold,
        speaker: recallOptions?.speaker ?? options.speaker,
        speakerToken,
      });
    },

    async ask(question, askOptions) {
      const answerer = requireAnswerer(); // fail fast, before spending a plan call
      const recalled = await this.recall(question, askOptions);
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

    facts: (entity) => store.listFacts(namespace, entity ? canonEntity(entity) : undefined),
    forget: (ids) => store.deleteFacts(namespace, ids),
    clear: () => store.clear(namespace),
    close: () => store.close(),
  };
}

