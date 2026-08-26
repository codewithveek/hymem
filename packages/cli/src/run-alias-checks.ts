#!/usr/bin/env node
/**
 * Entity aliases: "where does my wife live?" reaching facts stored under
 * "sarah".
 *
 * Aliases are extra entity links rather than a similarity index, so these are
 * exact-match assertions — a stub extractor stands in for the LLM and no API
 * key is needed.
 */
import {
  createMemory,
  memoryStore,
  aliasEntity,
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

/** One fact about `who`, optionally declaring aliases for them. */
function factExtractor(
  who: string,
  attribute: string,
  value: string,
  aliases: { alias: string; of: string }[] = [],
): Extractor {
  return {
    async extract(session: SessionInput): Promise<ExtractedFact[]> {
      return [
        {
          subject: who,
          attribute,
          value,
          text: `${who}'s ${attribute} is ${value}`,
          entities: ["user", who],
          aliases,
          observedAt: session.ts,
          sessionId: session.id,
        },
      ];
    },
  };
}

/** Plans exactly the entity it was built with — standing in for the LLM planner. */
const planFor = (entity: string): QueryPlanner => ({
  async plan() {
    return { entities: [entity], attributes: [], temporal: "current", at: null };
  },
});

const session = (id: string, ts: string, speaker?: string): SessionInput => ({
  id,
  ts,
  idx: 0,
  turns: [{ role: "user", content: "…" }],
  speaker,
});

const AT1 = "2026-01-01T00:00:00Z";
const AT2 = "2026-02-01T00:00:00Z";

// --- an alias reaches the fact it was declared on --------------------------
{
  const store = memoryStore();
  const build = (extractor: Extractor, planner: QueryPlanner) =>
    createMemory({ store, namespace: "solo", extractor, planner, answerer: null });

  await build(
    factExtractor("sarah", "home_city", "lisbon", [{ alias: "wife", of: "sarah" }]),
    planFor("sarah"),
  ).remember(session("s1", AT1));

  const byName = await build(factExtractor("x", "y", "z"), planFor("sarah")).recall("where?");
  const byAlias = await build(factExtractor("x", "y", "z"), planFor("wife")).recall("where?");

  check("the canonical name still resolves", byName.facts.length === 1);
  check(
    "the alias resolves to the same fact",
    byAlias.facts.length === 1 && byAlias.facts[0].value === "lisbon",
    byAlias.facts.map((fact) => fact.value).join(", ") || "(nothing)",
  );

  const unrelated = await build(factExtractor("x", "y", "z"), planFor("husband")).recall("where?");
  check("an undeclared alias matches nothing", unrelated.facts.length === 0);
}

// --- aliases are speaker-scoped in a shared namespace ----------------------
{
  const store = memoryStore();
  const build = (extractor: Extractor, planner: QueryPlanner, speaker?: string) =>
    createMemory({ store, namespace: "org", extractor, planner, answerer: null, speaker });

  await build(
    factExtractor("sarah", "home_city", "lisbon", [{ alias: "wife", of: "sarah" }]),
    planFor("sarah"),
    "alice",
  ).remember(session("s1", AT1, "alice"));

  await build(
    factExtractor("dana", "home_city", "berlin", [{ alias: "wife", of: "dana" }]),
    planFor("dana"),
    "bob",
  ).remember(session("s2", AT2, "bob"));

  const asAlice = await build(factExtractor("x", "y", "z"), planFor("wife"), "alice").recall("where?");
  const asBob = await build(factExtractor("x", "y", "z"), planFor("wife"), "bob").recall("where?");

  check(
    "alice's 'wife' resolves only to sarah",
    asAlice.facts.length === 1 && asAlice.facts[0].value === "lisbon",
    asAlice.facts.map((fact) => `${fact.subject}=${fact.value}`).join(", ") || "(nothing)",
  );
  check(
    "bob's 'wife' resolves only to dana",
    asBob.facts.length === 1 && asBob.facts[0].value === "berlin",
    asBob.facts.map((fact) => `${fact.subject}=${fact.value}`).join(", ") || "(nothing)",
  );
}

// --- an alias for an entity not in the fact is ignored ---------------------
{
  const store = memoryStore();
  const memory = createMemory({
    store,
    namespace: "solo",
    // The extractor claims "wife" means someone this fact never mentions.
    extractor: factExtractor("sarah", "home_city", "lisbon", [{ alias: "wife", of: "dana" }]),
    planner: planFor("sarah"),
    answerer: null,
  });
  await memory.remember(session("s1", AT1));

  const [fact] = await store.listFacts("solo");
  check(
    "an alias whose target is absent from the fact is dropped",
    !fact.entities.some((entity) => entity.startsWith("alias:")),
    fact.entities.join(", "),
  );
}

// --- the stored shape is inspectable --------------------------------------
{
  const store = memoryStore();
  const memory = createMemory({
    store,
    namespace: "solo",
    extractor: factExtractor("sarah", "home_city", "lisbon", [{ alias: "wife", of: "sarah" }]),
    planner: planFor("sarah"),
    answerer: null,
  });
  await memory.remember(session("s1", AT1));

  const [fact] = await store.listFacts("solo");
  check(
    "the alias is a visible entity link, not hidden state",
    fact.entities.includes(aliasEntity("wife")),
    fact.entities.join(", "),
  );
  check(
    "aliases do not disturb the canonical entities",
    fact.entities.includes("sarah") && fact.entities.includes("user"),
    fact.entities.join(", "),
  );
}

// --- aliases never cross a namespace --------------------------------------
{
  const store = memoryStore();
  const build = (namespace: string) =>
    createMemory({
      store,
      namespace,
      extractor: factExtractor("sarah", "home_city", "lisbon", [{ alias: "wife", of: "sarah" }]),
      planner: planFor("wife"),
      answerer: null,
    });

  await build("tenant_a").remember(session("s1", AT1));
  const other = await build("tenant_b").recall("where?");
  check("an alias declared in one namespace is invisible in another", other.facts.length === 0);
}

console.log(failures === 0 ? "\nall alias checks passed" : `\n${failures} alias check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
