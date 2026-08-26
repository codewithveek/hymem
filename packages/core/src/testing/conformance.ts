/**
 * Executable definition of a correct MemoryStore.
 *
 * Any adapter — first- or third-party — is expected to pass this suite before
 * being called a hymem store. It runs without an LLM and without network
 * access to anything but the store under test, so adapter authors need no API
 * keys to verify their work.
 *
 *   import { runStoreConformance } from "@hymem/core/testing";
 *   await runStoreConformance(() => postgres({ pool }));
 */
import type { MemoryStore } from "../core/ports.js";
import type { Fact, StoredFact } from "../core/types.js";
import { factId } from "../core/ids.js";

/** The namespace almost every test works in. */
const NS = "tenant_a";
/** A second tenant, used to prove isolation. */
const OTHER_NS = "tenant_b";

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
  namespace: string = NS,
): Fact {
  return {
    id: factId(namespace, subject, attribute, value),
    namespace,
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
  const namespace = incomingFact.namespace;
  await store.putSession(namespace, {
    id: incomingFact.sessionId,
    ts: incomingFact.observedAt,
    idx: 0,
  });
  await store.putFacts([asActive(incomingFact)]);
  await store.linkEntities(
    namespace,
    incomingFact.entities.map((entity) => ({ factId: incomingFact.id, entity })),
  );
  await store.supersede(asActive(incomingFact));
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
      const [roundTripped] = await store.search({ namespace: NS, entities: ["user"], limit: 10 });
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

      const allFacts = await store.listFacts(NS, "user");
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
      const hist = await store.getSupersededBy(NS, newer.id);
      eq(hist, [{ value: "lisbon", observedAt: AT.session1 }], "supersession history wrong");
      eq(await store.getSupersededBy(NS, older.id), [], "oldest fact should have superseded nothing");
    },
  },
  {
    name: "a different attribute does NOT supersede",
    run: async (store) => {
      await state(store, fact("user", "home_city", "lisbon", AT.session1, "s1"));
      await state(store, fact("user", "job_title", "chef", AT.session2, "s2"));
      const allFacts = await store.listFacts(NS, "user");
      eq(allFacts.filter((storedFact) => storedFact.status === "active").length, 2, "unrelated attributes should coexist");
    },
  },
  {
    name: "a different subject does NOT supersede",
    run: async (store) => {
      await state(store, fact("user", "home_city", "lisbon", AT.session1, "s1"));
      await state(store, fact("alice", "home_city", "berlin", AT.session2, "s2"));
      const allFacts = await store.listFacts(NS);
      eq(allFacts.filter((storedFact) => storedFact.status === "active").length, 2, "different subjects should coexist");
    },
  },
  {
    name: "re-ingesting the same history is idempotent",
    run: async (store) => {
      const storedFact = fact("user", "home_city", "lisbon", AT.session1, "s1");
      await state(store, storedFact);
      await state(store, storedFact);
      const allFacts = await store.listFacts(NS);
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

      const allFacts = await store.listFacts(NS, "user");
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
    name: "supersede ignores facts observed at or after the incoming one",
    run: async (store) => {
      await state(store, fact("user", "home_city", "berlin", AT.session3, "s3"));
      const older = fact("user", "home_city", "lisbon", AT.session1, "s1");
      const closed = await store.supersede(asActive(older));
      eq(closed, [], "a fact from the future must not be superseded by an older statement");
      const berlin = (await store.listFacts(NS, "user")).find(
        (storedFact) => storedFact.value === "berlin",
      );
      eq(berlin?.status, "active", "the newer fact must remain active");
    },
  },
  {
    name: "supersede returns the ids it closed",
    run: async (store) => {
      const older = fact("user", "home_city", "lisbon", AT.session1, "s1");
      await state(store, older);
      const newer = fact("user", "home_city", "berlin", AT.session2, "s2");
      await store.putSession(NS, { id: newer.sessionId, ts: newer.observedAt, idx: 0 });
      await store.putFacts([asActive(newer)]);
      await store.linkEntities(
        NS,
        newer.entities.map((entity) => ({ factId: newer.id, entity })),
      );
      eq(await store.supersede(asActive(newer)), [older.id], "supersede must return the closed ids");
    },
  },
  {
    name: "supersede is idempotent",
    run: async (store) => {
      const older = fact("user", "home_city", "lisbon", AT.session1, "s1");
      const newer = fact("user", "home_city", "berlin", AT.session2, "s2");
      await state(store, older);
      await state(store, newer);
      // Second run: the old fact is already closed, so nothing is left to close.
      eq(await store.supersede(asActive(newer)), [], "re-running supersede must close nothing new");
      eq(
        await store.getSupersededBy(NS, newer.id),
        [{ value: "lisbon", observedAt: AT.session1 }],
        "re-running supersede must not duplicate the chain",
      );
    },
  },
  {
    name: "concurrent supersede leaves exactly one active fact per slot",
    needs: "atomicSupersede",
    run: async (store) => {
      await state(store, fact("user", "home_city", "lisbon", AT.session1, "s1"));
      const berlin = fact("user", "home_city", "berlin", AT.session2, "s2");
      const madrid = fact("user", "home_city", "madrid", AT.session3, "s3");
      // Both writers stage their fact, then race to claim the slot.
      for (const incoming of [berlin, madrid]) {
        await store.putSession(NS, { id: incoming.sessionId, ts: incoming.observedAt, idx: 0 });
        await store.putFacts([asActive(incoming)]);
        await store.linkEntities(
          NS,
          incoming.entities.map((entity) => ({ factId: incoming.id, entity })),
        );
      }
      await Promise.all([store.supersede(asActive(madrid)), store.supersede(asActive(berlin))]);
      const active = (await store.listFacts(NS, "user")).filter(
        (storedFact) => storedFact.status === "active",
      );
      eq(active.map((storedFact) => storedFact.value), ["madrid"], "exactly the newest value should remain active");
    },
  },
  {
    name: "search filters by attribute when given",
    run: async (store) => {
      await state(store, fact("user", "home_city", "lisbon", AT.session1, "s1"));
      await state(store, fact("user", "job_title", "chef", AT.session2, "s2"));
      const matches = await store.search({ namespace: NS, entities: ["user"], attributes: ["job_title"], limit: 10 });
      eq(matches.map((storedFact) => storedFact.attribute), ["job_title"], "attribute filter not applied");
    },
  },
  {
    name: "search matches any of several entities and de-duplicates",
    run: async (store) => {
      await state(store, fact("user", "employer", "acme", AT.session1, "s1", ["user", "acme"]));
      const matches = await store.search({ namespace: NS, entities: ["user", "acme"], limit: 10 });
      eq(matches.length, 1, "a fact about two matched entities must appear once");
    },
  },
  {
    name: "search returns the MOST RECENT matches, ordered ascending",
    run: async (store) => {
      await state(store, fact("user", "a", "1", AT.session1, "s1"));
      await state(store, fact("user", "b", "2", AT.session2, "s2"));
      await state(store, fact("user", "c", "3", AT.session3, "s3"));
      const matches = await store.search({ namespace: NS, entities: ["user"], limit: 2 });
      eq(matches.map((storedFact) => storedFact.value), ["2", "3"], "limit must keep the newest, sorted oldest-first");
    },
  },
  {
    name: "listFacts is ascending by observedAt and filters by entity",
    run: async (store) => {
      await state(store, fact("user", "a", "1", AT.session2, "s2"));
      await state(store, fact("user", "b", "2", AT.session1, "s1"));
      await state(store, fact("alice", "c", "3", AT.session3, "s3"));
      eq((await store.listFacts(NS, "user")).map((storedFact) => storedFact.value), ["2", "1"], "listFacts(entity) order or filter wrong");
      eq((await store.listFacts(NS)).length, 3, "unfiltered listFacts should return everything");
    },
  },
  {
    name: "deleteFacts removes the fact and its supersession edges",
    run: async (store) => {
      const older = fact("user", "home_city", "lisbon", AT.session1, "s1");
      const newer = fact("user", "home_city", "berlin", AT.session2, "s2");
      await state(store, older);
      await state(store, newer);
      await store.deleteFacts(NS, [older.id]);
      eq((await store.listFacts(NS)).map((storedFact) => storedFact.id), [newer.id], "deleted fact still present");
      eq(await store.getSupersededBy(NS, newer.id), [], "dangling supersession edge after delete");
      await store.deleteFacts(NS, ["does-not-exist"]); // must not throw
    },
  },
  {
    name: "clear empties the store",
    run: async (store) => {
      await state(store, fact("user", "home_city", "lisbon", AT.session1, "s1"));
      await store.clear(NS);
      eq(await store.listFacts(NS), [], "clear left facts behind");
      eq(await store.search({ namespace: NS, entities: ["user"], limit: 10 }), [], "clear left the entity index behind");
    },
  },
  {
    name: "unknown entities and empty inputs are handled without throwing",
    run: async (store) => {
      eq(await store.search({ namespace: NS, entities: ["nobody"], limit: 10 }), [], "unknown entity should return []");
      eq(await store.getSupersededBy(NS, "nope"), [], "unknown fact should return []");
      await store.putFacts([]);
      await store.linkEntities(NS, []);
      await store.deleteFacts(NS, []);
      eq(
        await store.supersede(asActive(fact("nobody", "nothing", "none", AT.session1, "s1"))),
        [],
        "supersede against an empty slot should close nothing",
      );
    },
  },
  {
    name: "TENANCY: search never crosses a namespace",
    run: async (store) => {
      await state(store, fact("user", "home_city", "lisbon", AT.session1, "s1"));
      await state(store, fact("user", "home_city", "berlin", AT.session1, "s1", ["user"], OTHER_NS));
      const mine = await store.search({ namespace: NS, entities: ["user"], limit: 10 });
      eq(mine.map((storedFact) => storedFact.value), ["lisbon"], "search leaked across namespaces");
      const theirs = await store.search({ namespace: OTHER_NS, entities: ["user"], limit: 10 });
      eq(theirs.map((storedFact) => storedFact.value), ["berlin"], "the other namespace saw the wrong facts");
    },
  },
  {
    name: "TENANCY: listFacts never crosses a namespace",
    run: async (store) => {
      await state(store, fact("user", "home_city", "lisbon", AT.session1, "s1"));
      await state(store, fact("user", "job_title", "chef", AT.session1, "s1", ["user"], OTHER_NS));
      eq((await store.listFacts(NS)).length, 1, "unfiltered listFacts leaked across namespaces");
      eq((await store.listFacts(NS, "user")).length, 1, "entity-filtered listFacts leaked");
      eq((await store.listFacts(OTHER_NS)).length, 1, "the other namespace saw the wrong facts");
    },
  },
  {
    name: "TENANCY: the same triple in two namespaces is two independent facts",
    run: async (store) => {
      const mine = fact("user", "home_city", "lisbon", AT.session1, "s1");
      const theirs = fact("user", "home_city", "lisbon", AT.session1, "s1", ["user"], OTHER_NS);
      assert(mine.id !== theirs.id, "identical triples in different namespaces must not share an id");
      await state(store, mine);
      await state(store, theirs);
      eq((await store.listFacts(NS)).length, 1, "namespace A should hold exactly its own fact");
      eq((await store.listFacts(OTHER_NS)).length, 1, "namespace B should hold exactly its own fact");
    },
  },
  {
    name: "TENANCY: supersession does not reach across a namespace",
    run: async (store) => {
      await state(store, fact("user", "home_city", "lisbon", AT.session1, "s1"));
      // A later, different value for the SAME slot, in another tenant.
      await state(store, fact("user", "home_city", "berlin", AT.session2, "s2", ["user"], OTHER_NS));
      const mine = await store.listFacts(NS);
      eq(mine.length, 1, "namespace A should be untouched");
      eq(mine[0].status, "active", "another tenant's write must not supersede this one");
      eq(mine[0].validTo, null, "another tenant's write must not close this fact");
    },
  },
  {
    name: "TENANCY: clear wipes one namespace and leaves the other intact",
    run: async (store) => {
      await state(store, fact("user", "home_city", "lisbon", AT.session1, "s1"));
      await state(store, fact("user", "home_city", "berlin", AT.session1, "s1", ["user"], OTHER_NS));
      await store.clear(NS);
      eq(await store.listFacts(NS), [], "clear should empty its own namespace");
      eq((await store.listFacts(OTHER_NS)).length, 1, "clear must not touch another namespace");
      await store.clear(OTHER_NS);
    },
  },
  {
    name: "TENANCY: deleteFacts cannot delete another namespace's fact",
    run: async (store) => {
      const theirs = fact("user", "home_city", "berlin", AT.session1, "s1", ["user"], OTHER_NS);
      await state(store, theirs);
      // Correct id, wrong namespace: must be a no-op.
      await store.deleteFacts(NS, [theirs.id]);
      eq((await store.listFacts(OTHER_NS)).length, 1, "a foreign namespace deleted another tenant's fact");
      await store.clear(OTHER_NS);
    },
  },
  {
    name: "TENANCY: getSupersededBy does not read across a namespace",
    run: async (store) => {
      const older = fact("user", "home_city", "lisbon", AT.session1, "s1", ["user"], OTHER_NS);
      const newer = fact("user", "home_city", "berlin", AT.session2, "s2", ["user"], OTHER_NS);
      await state(store, older);
      await state(store, newer);
      eq(await store.getSupersededBy(NS, newer.id), [], "history leaked across namespaces");
      eq(
        (await store.getSupersededBy(OTHER_NS, newer.id)).length,
        1,
        "the owning namespace should still see its history",
      );
      await store.clear(OTHER_NS);
    },
  },
  {
    name: "putFacts writes a batch spanning namespaces, sessions included",
    run: async (store) => {
      const mine = fact("user", "home_city", "lisbon", AT.session1, "s1");
      const theirs = fact("user", "home_city", "berlin", AT.session2, "s2", ["user"], OTHER_NS);
      // Deliberately no putSession: the port lets a caller write facts for a
      // session the store has not seen, and each fact names its own namespace.
      // A store that reads the namespace off the first fact and applies it to
      // the whole batch loses the second one's provenance.
      await store.putFacts([asActive(mine), asActive(theirs)]);
      eq(
        (await store.listFacts(NS)).map((storedFact) => storedFact.value),
        ["lisbon"],
        "the first namespace's fact did not survive a mixed batch",
      );
      eq(
        (await store.listFacts(OTHER_NS)).map((storedFact) => storedFact.value),
        ["berlin"],
        "the second namespace's fact did not survive a mixed batch",
      );
      await store.clear(OTHER_NS);
    },
  },
  {
    name: "search treats limit as an upper bound, zero included",
    run: async (store) => {
      await state(store, fact("user", "home_city", "lisbon", AT.session1, "s1"));
      eq(
        (await store.search({ namespace: NS, entities: ["user"], limit: 0 })).length,
        0,
        "limit 0 asks for no facts and must return none",
      );
    },
  },
  {
    name: "TENANCY: linkEntities cannot index another namespace's fact",
    run: async (store) => {
      const theirs = fact("user", "home_city", "berlin", AT.session1, "s1", ["user"], OTHER_NS);
      await state(store, theirs);
      // The right id, the wrong namespace. Two things must hold: this namespace
      // cannot pull the fact into its own index, and the owning namespace's
      // index is not a stranger's to write either.
      await store.linkEntities(NS, [{ factId: theirs.id, entity: "smuggled" }]);
      eq(
        await store.search({ namespace: NS, entities: ["smuggled"], limit: 10 }),
        [],
        "a foreign fact id was indexed into another namespace",
      );
      eq(
        (await store.search({ namespace: OTHER_NS, entities: ["smuggled"], limit: 10 })).length,
        0,
        "one namespace changed what another namespace's search returns",
      );
      await store.clear(OTHER_NS);
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
      // Both tenants, so a leak from a previous test cannot be mistaken for a pass.
      await store.clear(NS);
      await store.clear(OTHER_NS);
      await test.run(store);
      result.passed++;
      if (opts.verbose) console.log(`  ok   ${test.name}`);
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown.message : String(thrown);
      result.failed.push({ name: test.name, error });
      if (opts.verbose) console.log(`  FAIL ${test.name}\n    ${error.replace(/\n/g, "\n    ")}`);
    } finally {
      await store.clear(NS).catch(() => undefined);
      await store.clear(OTHER_NS).catch(() => undefined);
    }
  }
  return result;
}

export const CONFORMANCE_TEST_COUNT = TESTS.length;
