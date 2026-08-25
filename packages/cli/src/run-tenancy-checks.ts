#!/usr/bin/env node
/**
 * Core-level tenancy behaviour: the speaker rewrite, identity assignment, and
 * the org scenario two people sharing one namespace.
 *
 * These sit above the store contract, so `runStoreConformance` cannot cover
 * them. A stub extractor stands in for the LLM, so this needs no API key.
 */
import {
  createMemory,
  memoryStore,
  type ExtractedFact,
  type Extractor,
  type QueryPlanner,
  type SessionInput,
} from "@hymem/core";

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? `\n    ${detail}` : ""}`);
  }
}

/** Emits one triple about the speaker, exactly as the LLM extractor would. */
function stubExtractor(attribute: string, value: string): Extractor {
  return {
    async extract(session: SessionInput): Promise<ExtractedFact[]> {
      return [
        {
          subject: "user",
          attribute,
          value,
          text: `the user's ${attribute} is ${value}`,
          entities: ["user"],
          observedAt: session.ts,
          sessionId: session.id,
        },
      ];
    },
  };
}

/** Always plans the same lookup: the speaker token, no attribute filter. */
const stubPlanner: QueryPlanner = {
  async plan() {
    return { entities: ["user"], attributes: [], temporal: "current", at: null };
  },
};

const session = (id: string, ts: string, speaker?: string, speakerName?: string): SessionInput => ({
  id,
  ts,
  idx: 0,
  turns: [{ role: "user", content: "…" }],
  speaker,
  speakerName,
});

// --- Two people in one namespace must not collide --------------------------
{
  const store = memoryStore();
  const build = (attribute: string, value: string) =>
    createMemory({
      store,
      namespace: "org_42",
      extractor: stubExtractor(attribute, value),
      planner: stubPlanner,
      answerer: null,
    });

  await build("home_city", "lisbon").remember(session("s1", "2024-01-01T00:00:00Z", "alice"));
  await build("home_city", "berlin").remember(session("s2", "2024-02-01T00:00:00Z", "bob"));

  const facts = await store.listFacts("org_42");
  const alice = facts.find((fact) => fact.subject === "alice");
  const bob = facts.find((fact) => fact.subject === "bob");

  check("two speakers in one namespace produce two distinct subjects", !!alice && !!bob);
  check(
    "neither speaker's fact was superseded by the other",
    alice?.status === "active" && bob?.status === "active",
    `alice=${alice?.status} bob=${bob?.status}`,
  );
  check(
    "the two facts have different ids",
    !!alice && !!bob && alice.id !== bob.id,
  );
}

// --- Recall in a shared namespace is scoped to the asking speaker ----------
{
  const store = memoryStore();
  const build = (attribute: string, value: string) =>
    createMemory({
      store,
      namespace: "org_42",
      extractor: stubExtractor(attribute, value),
      planner: stubPlanner,
      answerer: null,
    });

  await build("home_city", "lisbon").remember(session("s1", "2024-01-01T00:00:00Z", "alice"));
  await build("home_city", "berlin").remember(session("s2", "2024-02-01T00:00:00Z", "bob"));

  const reader = build("unused", "unused");
  const asAlice = await reader.recall("where do I live?", { speaker: "alice" });
  const asBob = await reader.recall("where do I live?", { speaker: "bob" });

  check(
    "recall as alice returns only alice's fact",
    asAlice.facts.length === 1 && asAlice.facts[0].value === "lisbon",
    asAlice.facts.map((fact) => `${fact.subject}=${fact.value}`).join(", "),
  );
  check(
    "recall as bob returns only bob's fact",
    asBob.facts.length === 1 && asBob.facts[0].value === "berlin",
    asBob.facts.map((fact) => `${fact.subject}=${fact.value}`).join(", "),
  );
}

// --- Opaque speaker ids stay reachable by display name --------------------
{
  const store = memoryStore();
  const memory = createMemory({
    store,
    namespace: "org_42",
    extractor: stubExtractor("home_city", "denver"),
    planner: stubPlanner,
    answerer: null,
  });
  await memory.remember(session("s1", "2024-01-01T00:00:00Z", "usr_7f3a91", "bob"));

  const [fact] = await store.listFacts("org_42");
  check("identity is the opaque id, not the display name", fact?.subject === "usr_7f3a91", fact?.subject);
  check(
    "the display name is linked as an entity so name-based recall resolves",
    fact?.entities.includes("bob") && fact?.entities.includes("usr_7f3a91"),
    fact?.entities.join(", "),
  );
  const byName = await store.search({ namespace: "org_42", entities: ["bob"], limit: 10 });
  check("searching by display name finds the id-keyed fact", byName.length === 1);
}

// --- One speaker per namespace needs no speaker at all --------------------
{
  const store = memoryStore();
  const memory = createMemory({
    store,
    namespace: "usr_alice",
    extractor: stubExtractor("home_city", "lisbon"),
    planner: stubPlanner,
    answerer: null,
  });
  await memory.remember(session("s1", "2024-01-01T00:00:00Z"));
  const [fact] = await store.listFacts("usr_alice");
  check("with no speaker the token stays literal", fact?.subject === "user", fact?.subject);
  const recalled = await memory.recall("where do I live?");
  check("recall still resolves without a speaker", recalled.facts.length === 1);
}

// --- speakerToken is configurable ----------------------------------------
{
  const store = memoryStore();
  const memory = createMemory({
    store,
    namespace: "org_42",
    speakerToken: "__self__",
    // Emits "user" as a REAL entity — a product's end user, not the speaker.
    extractor: {
      async extract(input) {
        return [
          {
            subject: "user",
            attribute: "count",
            value: "5000",
            text: "the product has 5000 users",
            entities: ["user"],
            observedAt: input.ts,
            sessionId: input.id,
          },
        ];
      },
    },
    planner: stubPlanner,
    answerer: null,
  });
  await memory.remember(session("s1", "2024-01-01T00:00:00Z", "alice"));
  const [fact] = await store.listFacts("org_42");
  check(
    'with a custom token, a literal "user" entity is NOT rewritten to the speaker',
    fact?.subject === "user",
    fact?.subject,
  );
}

// --- namespace is required ------------------------------------------------
{
  let thrown: unknown;
  try {
    createMemory({ store: memoryStore(), namespace: "", planner: stubPlanner });
  } catch (error) {
    thrown = error;
  }
  check("createMemory rejects an empty namespace", thrown instanceof Error);
}

console.log(failures === 0 ? "\nall tenancy checks passed" : `\n${failures} tenancy check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
