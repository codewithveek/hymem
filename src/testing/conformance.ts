/**
 * Executable definition of a correct MemoryStore.
 *
 * Any adapter — first- or third-party — is expected to pass this suite before
 * being called a hymem store. It runs without an LLM and without network
 * access to anything but the store under test, so adapter authors need no API
 * keys to verify their work.
 *
 *   import { runStoreConformance } from "hymem/testing";
 *   await runStoreConformance(() => postgres({ pool }));
 */
import type { MemoryStore } from "../core/ports.js";
import type { Fact, StoredFact } from "../core/types.js";
import { factId } from "../core/ids.js";

export interface ConformanceResult {
  passed: number;
  failed: { name: string; error: string }[];
  skipped: string[];
}

/** Three well-separated observation times, so ordering assertions are unambiguous. */
const AT = {
  session1: "2024-01-01T00:00:00Z",
  session2: "2024-02-01T00:00:00Z",
  session3: "2024-03-01T00:00:00Z",
};

function fact(
  subject: string,
  attribute: string,
  value: string,
  observedAt: string,
  sessionId: string,
  entities?: string[],
): Fact {
  return {
    id: factId(subject, attribute, value),
    subject,
    attribute,
    value,
    text: `${subject} ${attribute} is ${value}`,
    entities: entities ?? [subject],
    observedAt,
    sessionId,
  };
}

const asActive = (fact: Fact): StoredFact => ({
  ...fact,
  status: "active",
  validFrom: fact.observedAt,
  validTo: null,
});

/** Write a fact through the full ingest path so supersession is exercised. */
async function state(store: MemoryStore, incomingFact: Fact): Promise<void> {
  await store.putSession({ id: incomingFact.sessionId, ts: incomingFact.observedAt, idx: 0 });
  await store.putFacts([asActive(incomingFact)]);
  await store.linkEntities(
    incomingFact.entities.map((entity) => ({ factId: incomingFact.id, entity })),
  );
  const supersededIds = await store.findSupersedable({
    subject: incomingFact.subject,
    attribute: incomingFact.attribute,
    value: incomingFact.value,
    before: incomingFact.observedAt,
    excludeId: incomingFact.id,
  });
  if (supersededIds.length) {
    await store.closeFacts(supersededIds, incomingFact.observedAt);
    await store.linkSupersedes(incomingFact.id, supersededIds);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const eq = (actual: unknown, expected: unknown, message: string) =>
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
  );

type Test = {
  name: string;
  needs?: keyof MemoryStore["capabilities"];
  run: (store: MemoryStore) => Promise<void>;
};

const TESTS: Test[] = [
  {
    name: "putFacts + search round-trips a fact intact",
    run: async (store) => {
      const storedFact = fact("user", "home_city", "lisbon", AT.session1, "s1");
      await state(store, storedFact);
      const [roundTripped] = await store.search({ entities: ["user"], limit: 10 });
      assert(roundTripped, "search returned nothing");
      eq(
        {
          id: roundTripped.id,
          subject: roundTripped.subject,
          attribute: roundTripped.attribute,
          value: roundTripped.value,
          status: roundTripped.status,
          validTo: roundTripped.validTo,
        },
        { id: storedFact.id, subject: "user", attribute: "home_city", value: "lisbon", status: "active", validTo: null },
        "round-tripped fact differs",
      );
    },
  },
  {
    name: "a later different value supersedes the earlier one",
    run: async (store) => {
      const older = fact("user", "home_city", "lisbon", AT.session1, "s1");
      const newer = fact("user", "home_city", "berlin", AT.session2, "s2");
      await state(store, older);
      await state(store, newer);

      const allFacts = await store.listFacts("user");
      const lisbon = allFacts.find((storedFact) => storedFact.value === "lisbon");
      const berlin = allFacts.find((storedFact) => storedFact.value === "berlin");
      assert(lisbon && berlin, "both values should still be stored");
      eq(lisbon.status, "superseded", "older fact should be superseded");
      eq(lisbon.validTo, AT.session2, "older fact validTo should be the newer observedAt");
      eq(berlin.status, "active", "newer fact should be active");
      eq(berlin.validTo, null, "newer fact should have an open validTo");
    },
  },
  {
    name: "supersession is recorded and readable",
    run: async (store) => {
      const older = fact("user", "home_city", "lisbon", AT.session1, "s1");
      const newer = fact("user", "home_city", "berlin", AT.session2, "s2");
      await state(store, older);
      await state(store, newer);
      const hist = await store.getSupersededBy(newer.id);
      eq(hist, [{ value: "lisbon", observedAt: AT.session1 }], "supersession history wrong");
      eq(await store.getSupersededBy(older.id), [], "oldest fact should have superseded nothing");
    },
  },
  {
    name: "a different attribute does NOT supersede",
    run: async (store) => {
      await state(store, fact("user", "home_city", "lisbon", AT.session1, "s1"));
      await state(store, fact("user", "job_title", "chef", AT.session2, "s2"));
      const allFacts = await store.listFacts("user");
      eq(allFacts.filter((storedFact) => storedFact.status === "active").length, 2, "unrelated attributes should coexist");
    },
  },
  {
    name: "a different subject does NOT supersede",
    run: async (store) => {
      await state(store, fact("user", "home_city", "lisbon", AT.session1, "s1"));
      await state(store, fact("alice", "home_city", "berlin", AT.session2, "s2"));
      const allFacts = await store.listFacts();
      eq(allFacts.filter((storedFact) => storedFact.status === "active").length, 2, "different subjects should coexist");
    },
  },
  {
    name: "re-ingesting the same history is idempotent",
    run: async (store) => {
      const storedFact = fact("user", "home_city", "lisbon", AT.session1, "s1");
      await state(store, storedFact);
      await state(store, storedFact);
      const allFacts = await store.listFacts();
      eq(allFacts.length, 1, "re-stating a fact must not duplicate it");
      eq(allFacts[0].status, "active", "re-stated fact should stay active");
    },
  },
  {
    name: "re-stating a superseded fact re-activates it and clears validTo",
    run: async (store) => {
      const lisbon = fact("user", "home_city", "lisbon", AT.session1, "s1");
      await state(store, lisbon);
      await state(store, fact("user", "home_city", "berlin", AT.session2, "s2"));
      // Moved back.
      await state(store, { ...lisbon, observedAt: AT.session3, sessionId: "s3" });

      const allFacts = await store.listFacts("user");
      const restated = allFacts.find((storedFact) => storedFact.value === "lisbon");
      const berlin = allFacts.find((storedFact) => storedFact.value === "berlin");
      assert(restated && berlin, "both facts should exist");
      eq(restated.status, "active", "re-stated fact must re-activate");
      eq(restated.validTo, null, "re-activation must clear validTo");
      eq(restated.validFrom, AT.session3, "re-activation must refresh validFrom");
      eq(berlin.status, "superseded", "the value it replaced must close");
      eq(berlin.validTo, AT.session3, "closed fact validTo should be the re-statement time");
    },
  },
  {
    name: "findSupersedable ignores facts observed at or after the incoming one",
    run: async (store) => {
      await state(store, fact("user", "home_city", "berlin", AT.session3, "s3"));
      const older = fact("user", "home_city", "lisbon", AT.session1, "s1");
      const candidates = await store.findSupersedable({
        subject: "user",
        attribute: "home_city",
        value: older.value,
        before: older.observedAt,
        excludeId: older.id,
      });
      eq(candidates, [], "a fact from the future must not be superseded by an older statement");
    },
  },
  {
    name: "search filters by attribute when given",
    run: async (store) => {
      await state(store, fact("user", "home_city", "lisbon", AT.session1, "s1"));
      await state(store, fact("user", "job_title", "chef", AT.session2, "s2"));
      const matches = await store.search({ entities: ["user"], attributes: ["job_title"], limit: 10 });
      eq(matches.map((storedFact) => storedFact.attribute), ["job_title"], "attribute filter not applied");
    },
  },
  {
    name: "search matches any of several entities and de-duplicates",
    run: async (store) => {
      await state(store, fact("user", "employer", "acme", AT.session1, "s1", ["user", "acme"]));
      const matches = await store.search({ entities: ["user", "acme"], limit: 10 });
      eq(matches.length, 1, "a fact about two matched entities must appear once");
    },
  },
  {
    name: "search returns the MOST RECENT matches, ordered ascending",
    run: async (store) => {
      await state(store, fact("user", "a", "1", AT.session1, "s1"));
      await state(store, fact("user", "b", "2", AT.session2, "s2"));
      await state(store, fact("user", "c", "3", AT.session3, "s3"));
      const matches = await store.search({ entities: ["user"], limit: 2 });
      eq(matches.map((storedFact) => storedFact.value), ["2", "3"], "limit must keep the newest, sorted oldest-first");
    },
  },
  {
    name: "listFacts is ascending by observedAt and filters by entity",
    run: async (store) => {
      await state(store, fact("user", "a", "1", AT.session2, "s2"));
      await state(store, fact("user", "b", "2", AT.session1, "s1"));
      await state(store, fact("alice", "c", "3", AT.session3, "s3"));
      eq((await store.listFacts("user")).map((storedFact) => storedFact.value), ["2", "1"], "listFacts(entity) order or filter wrong");
      eq((await store.listFacts()).length, 3, "unfiltered listFacts should return everything");
    },
  },
  {
    name: "deleteFacts removes the fact and its supersession edges",
    run: async (store) => {
      const older = fact("user", "home_city", "lisbon", AT.session1, "s1");
      const newer = fact("user", "home_city", "berlin", AT.session2, "s2");
      await state(store, older);
      await state(store, newer);
      await store.deleteFacts([older.id]);
      eq((await store.listFacts()).map((storedFact) => storedFact.id), [newer.id], "deleted fact still present");
      eq(await store.getSupersededBy(newer.id), [], "dangling supersession edge after delete");
      await store.deleteFacts(["does-not-exist"]); // must not throw
    },
  },
  {
    name: "clear empties the store",
    run: async (store) => {
      await state(store, fact("user", "home_city", "lisbon", AT.session1, "s1"));
      await store.clear();
      eq(await store.listFacts(), [], "clear left facts behind");
      eq(await store.search({ entities: ["user"], limit: 10 }), [], "clear left the entity index behind");
    },
  },
  {
    name: "unknown entities and empty inputs are handled without throwing",
    run: async (store) => {
      eq(await store.search({ entities: ["nobody"], limit: 10 }), [], "unknown entity should return []");
      eq(await store.getSupersededBy("nope"), [], "unknown fact should return []");
      await store.putFacts([]);
      await store.linkEntities([]);
      await store.closeFacts([], AT.session1);
      await store.linkSupersedes("nope", []);
      await store.deleteFacts([]);
    },
  },
];

/**
 * Run the suite. `makeStore` is called once per test; each test starts from a
 * cleared store, so adapters may return the same instance every time.
 */
export async function runStoreConformance(
  makeStore: () => MemoryStore | Promise<MemoryStore>,
  opts: { verbose?: boolean } = {},
): Promise<ConformanceResult> {
  const result: ConformanceResult = { passed: 0, failed: [], skipped: [] };

  for (const test of TESTS) {
    const store = await makeStore();
    if (test.needs && !store.capabilities[test.needs]) {
      result.skipped.push(test.name);
      if (opts.verbose) console.log(`  - ${test.name} (skipped: needs ${test.needs})`);
      continue;
    }
    try {
      await store.clear();
      await test.run(store);
      result.passed++;
      if (opts.verbose) console.log(`  ok   ${test.name}`);
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown.message : String(thrown);
      result.failed.push({ name: test.name, error });
      if (opts.verbose) console.log(`  FAIL ${test.name}\n    ${error.replace(/\n/g, "\n    ")}`);
    } finally {
      await store.clear().catch(() => undefined);
    }
  }
  return result;
}

export const CONFORMANCE_TEST_COUNT = TESTS.length;
