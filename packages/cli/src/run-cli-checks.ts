#!/usr/bin/env node
/**
 * Checks for the shipped executables themselves, rather than for a store.
 *
 * The one that matters is the conformance guard: `runStoreConformance` clears
 * "tenant_a" and "tenant_b" around every test, and MEM_STORE names the store an
 * application actually uses — so the decision about whether a run is safe has
 * to be made before a connection is opened, and has to stay made.
 */
import { readFileSync } from "node:fs";
import { storeFromEnv, storeTargetFromEnv } from "./env.js";
import { UNKNOWN_VERSION, VERSION } from "./version.js";

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? `\n    ${detail}` : ""}`);
  }
}

/** Resolve a target under a specific environment, leaving the real one untouched. */
function targetUnder(environment: Record<string, string | undefined>) {
  const keys = ["MEM_STORE", "SQLITE_PATH", "DATABASE_URL", "PG_URL", "HYDRA_BOLT_URL", "BOLT_URL"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    for (const [key, value] of Object.entries(environment)) {
      if (value !== undefined) process.env[key] = value;
    }
    return storeTargetFromEnv();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// --- what counts as safe to destroy ----------------------------------------
{
  // The dangerous default: no MEM_STORE at all still means a real file on disk.
  const byDefault = targetUnder({});
  check(
    "the default store is persistent, so it is never treated as disposable",
    byDefault.kind === "sqlite" && byDefault.target === "hymem.db" && !byDefault.ephemeral,
    JSON.stringify(byDefault),
  );

  const inMemorySqlite = targetUnder({ MEM_STORE: "sqlite", SQLITE_PATH: ":memory:" });
  check(
    "sqlite at :memory: is disposable",
    inMemorySqlite.ephemeral,
    JSON.stringify(inMemorySqlite),
  );

  const onDiskSqlite = targetUnder({ MEM_STORE: "sqlite", SQLITE_PATH: "/var/app/prod.db" });
  check(
    "sqlite at a path is not disposable",
    !onDiskSqlite.ephemeral && onDiskSqlite.target === "/var/app/prod.db",
    JSON.stringify(onDiskSqlite),
  );

  check("the in-process store is disposable", targetUnder({ MEM_STORE: "memory" }).ephemeral);

  const remote = [
    targetUnder({ MEM_STORE: "postgres", DATABASE_URL: "postgres://u:p@host/db" }),
    targetUnder({ MEM_STORE: "neo4j", BOLT_URL: "bolt://host:7687" }),
    targetUnder({ MEM_STORE: "hydradb", HYDRA_BOLT_URL: "bolt://host:7687" }),
  ];
  check(
    "no remote store is ever disposable",
    remote.every((target) => !target.ephemeral),
    JSON.stringify(remote),
  );

  // An unknown kind is storeFromEnv's error to raise — but until it does, the
  // safe assumption is that it points at something real.
  check(
    "an unrecognised MEM_STORE is assumed persistent",
    !targetUnder({ MEM_STORE: "cassandra" }).ephemeral,
  );
}

// --- the description is printable ------------------------------------------
{
  const withPassword = targetUnder({
    MEM_STORE: "postgres",
    DATABASE_URL: "postgres://admin:sup3rs3cret@db.example.com:5432/prod",
  });
  check(
    "a connection string's password never reaches the terminal",
    !withPassword.target.includes("sup3rs3cret") && withPassword.target.includes("admin"),
    withPassword.target,
  );

  const unparseable = targetUnder({ MEM_STORE: "postgres", DATABASE_URL: "host=db password=hunter2" });
  check(
    "a connection string that is not a URL is withheld rather than guessed at",
    !unparseable.target.includes("hunter2"),
    unparseable.target,
  );

  check(
    "a missing connection string says so",
    targetUnder({ MEM_STORE: "postgres" }).target === "unset",
  );
}

// --- the description matches the store that actually gets built ------------
{
  // The drift this closes: `conformance` printed "hydradb" while writing to
  // hymem.db, because the banner and storeFromEnv each carried their own copy
  // of the default. Both read one helper now — assert it behaviourally rather
  // than trusting that they still do. SQLITE_PATH is forced to ":memory:" so
  // building the default store touches no disk.
  const keys = ["MEM_STORE", "SQLITE_PATH", "MEM_MIGRATE"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.MEM_STORE; // exercise the default, whatever it is
    process.env.SQLITE_PATH = ":memory:";
    process.env.MEM_MIGRATE = "auto"; // a fresh :memory: database has no schema
    const described = storeTargetFromEnv();
    const built = await storeFromEnv();
    // A store that answers a read is the one the description named: any other
    // adapter would have needed a service that is not running here.
    const readBack = await built.listFacts("tenant_a");
    check(
      "the described default and the built default are the same store",
      described.kind === "sqlite" && described.target === ":memory:" && readBack.length === 0,
      JSON.stringify(described),
    );
    await built.close();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// --- the version the executables report -------------------------------------
{
  // The real failure mode is not a wrong number — it is the manifest lookup
  // breaking silently when the output layout moves, leaving every `--version`
  // and every MCP handshake reporting a placeholder.
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  check(
    "the executables report the version npm publishes, not a literal",
    VERSION === manifest.version && VERSION !== UNKNOWN_VERSION,
    `reported ${VERSION}, manifest says ${manifest.version}`,
  );
}

console.log(failures === 0 ? "\nall CLI checks passed" : `\n${failures} CLI check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
