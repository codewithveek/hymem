#!/usr/bin/env node
/**
 * Core read- and write-path behaviour that sits above the store contract:
 * fact identity, and how recall interacts with a store's result limit.
 *
 * `runStoreConformance` cannot cover these — they are properties of core's own
 * algorithms, which every adapter inherits rather than implements.
 */
import { factId, memoryStore, recall, type QueryLink, type StoredFact } from "@hymem/core";

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? `\n    ${detail}` : ""}`);
  }
}

const NS = "tenant_a";

// --- Fact identity is injective -------------------------------------------
{
  // Every field is caller-supplied, so a delimiter can appear inside one. Two
  // different triples hashing alike would mean one silently overwriting the
  // other, because every store upserts on this id.
  const collisions: [string, string][] = [
    [factId(NS, "a|b", "c", "d"), factId(NS, "a", "b|c", "d")],
    [factId(NS, "a", "b", "c|d"), factId(NS, "a", "b|c", "d")],
    [factId("tenant|a", "b", "c", "d"), factId("tenant", "a|b", "c", "d")],
    [factId(NS, "", "a", "b"), factId(NS, "a", "", "b")],
  ];
  check(
    "distinct triples never share a fact id, whatever the delimiter",
    collisions.every(([left, right]) => left !== right),
    collisions.map(([left, right]) => `${left} vs ${right}`).join("; "),
  );
  check(
    "the same triple still hashes to the same id",
    factId(NS, "user", "home_city", "Lisbon") === factId(NS, "user", "home_city", "lisbon"),
  );
  check(
    "the namespace still separates identical triples",
    factId(NS, "user", "home_city", "lisbon") !==
      factId("tenant_b", "user", "home_city", "lisbon"),
  );
}

// --- Recall does not lose valid facts to the store's limit ------------------
{
  // The store limits before recall applies the time window. If the newest facts
  // are superseded or fall outside the window, they must not consume the budget
  // and leave a valid older fact unretrieved.
  const store = memoryStore();
  const observedAt = (month: number) => `2024-${String(month).padStart(2, "0")}-01T00:00:00Z`;

  const write = async (attribute: string, value: string, month: number): Promise<StoredFact> => {
    const stored: StoredFact = {
      id: factId(NS, "user", attribute, value),
      namespace: NS,
      subject: "user",
      attribute,
      value,
      text: `the user's ${attribute} is ${value}`,
      entities: ["user"],
      observedAt: observedAt(month),
      sessionId: `s${month}`,
      status: "active",
      validFrom: observedAt(month),
      validTo: null,
    };
    await store.putSession(NS, { id: stored.sessionId, ts: stored.observedAt, idx: month });
    await store.putFacts([stored]);
    await store.linkEntities(NS, [{ factId: stored.id, entity: "user" }]);
    await store.supersede(stored);
    return stored;
  };

  // One durable fact, then a long run of newer ones that overwrite each other.
  await write("home_city", "lisbon", 1);
  for (let month = 2; month <= 9; month++) await write("mood", `mood_${month}`, month);

  const currentLink: QueryLink = {
    entities: ["user"],
    attributes: [],
    temporal: "current",
    at: null,
  };
  const current = await recall(store, currentLink, {
    namespace: NS,
    maxFacts: 2,
    abstainThreshold: 1,
  });
  check(
    "an active older fact survives a window full of superseded newer ones",
    current.facts.some((fact) => fact.value === "lisbon"),
    current.facts.map((fact) => `${fact.attribute}=${fact.value}`).join(", "),
  );

  const pointInTimeLink: QueryLink = {
    entities: ["user"],
    attributes: [],
    temporal: "point_in_time",
    at: observedAt(3),
  };
  const asOfMarch = await recall(store, pointInTimeLink, {
    namespace: NS,
    maxFacts: 1,
    abstainThreshold: 1,
  });
  check(
    "a point-in-time question is not starved by facts outside its window",
    !asOfMarch.abstained && asOfMarch.facts.length === 1,
    `abstained=${asOfMarch.abstained} facts=${asOfMarch.facts
      .map((fact) => `${fact.attribute}=${fact.value}`)
      .join(", ")}`,
  );
  check(
    "and every fact it returns really is valid at that moment",
    asOfMarch.facts.every(
      (fact) => fact.validFrom <= observedAt(3) && (fact.validTo === null || observedAt(3) < fact.validTo),
    ),
    asOfMarch.facts.map((fact) => `${fact.validFrom}..${fact.validTo}`).join(", "),
  );
  check(
    "maxFacts is still an upper bound",
    asOfMarch.facts.length <= 1,
    `${asOfMarch.facts.length} facts`,
  );
}

console.log(failures === 0 ? "\nall core checks passed" : `\n${failures} core check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
