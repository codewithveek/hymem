/**
 * Schema ownership: hymem DECLARES the schema, you APPLY it.
 *
 * Column names are an implementation detail — the moment they are hand-written
 * into someone's migration they become public API and every future change is a
 * breaking one. So the definition lives here, and `migrate` decides how it
 * reaches the database:
 *
 *   "check" (default)  verify the tables exist, throw with instructions if not
 *   "auto"             create them if absent — fine for dev, wrong for ORMs
 *   "off"              you ran the DDL yourself
 *
 * "auto" is deliberately not the default. Silently creating tables in
 * production is how you get schema drift nobody notices, and for Drizzle or
 * Prisma users it desyncs the database from their schema file so their next
 * generate produces a bogus diff.
 */
import type { SqlDialect } from "./dialect.js";

export type MigrateMode = "check" | "auto" | "off";

export interface TableNames {
  facts: string;
  sessions: string;
  factEntities: string;
  supersedes: string;
}

/**
 * Table and column names cannot be bind parameters — SQL only binds values — so
 * an identifier reaching a statement is always string interpolation. The prefix
 * is caller-supplied configuration, which makes it the one identifier here that
 * is not a compile-time constant. Validate it rather than trust it.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class UnsafeTablePrefixError extends Error {
  constructor(prefix: string) {
    super(
      `hymem: table prefix ${JSON.stringify(prefix)} is not a valid SQL identifier. ` +
        "Use only letters, digits and underscores, starting with a letter or underscore " +
        '(for example "hymem_" or "agent_mem_").',
    );
    this.name = "UnsafeTablePrefixError";
  }
}

export function assertSafeTablePrefix(prefix: string): void {
  // An empty prefix is fine: it yields bare `facts`, `sessions`, and so on.
  if (prefix !== "" && !SAFE_IDENTIFIER.test(prefix)) throw new UnsafeTablePrefixError(prefix);
}

export function tableNames(prefix = "hymem_"): TableNames {
  assertSafeTablePrefix(prefix);
  return {
    facts: `${prefix}facts`,
    sessions: `${prefix}sessions`,
    factEntities: `${prefix}fact_entities`,
    supersedes: `${prefix}supersedes`,
  };
}

/**
 * DDL for the four tables plus the indexes recall depends on.
 *
 * Entities are a join table rather than a JSON column: `search` anchors on
 * entity, so it needs to be indexable, and normalising it is the natural SQL
 * shape rather than a graph translated word-for-word.
 */
export function createTableStatements(dialect: SqlDialect, tables: TableNames): string[] {
  const { keyType: key, textType: text, integerType: integer } = dialect;
  return [
    `CREATE TABLE IF NOT EXISTS ${tables.sessions} (
       namespace ${key} NOT NULL,
       id ${key} NOT NULL,
       ts ${key} NOT NULL,
       session_index ${integer} NOT NULL,
       previous_session_id ${key},
       speaker ${key},
       PRIMARY KEY (namespace, id)
     )`,
    `CREATE TABLE IF NOT EXISTS ${tables.facts} (
       id ${key} PRIMARY KEY,
       namespace ${key} NOT NULL,
       subject ${key} NOT NULL,
       attribute ${key} NOT NULL,
       value ${text} NOT NULL,
       fact_text ${text} NOT NULL,
       observed_at ${key} NOT NULL,
       session_id ${key} NOT NULL,
       status ${key} NOT NULL,
       valid_from ${key} NOT NULL,
       valid_to ${key}
     )`,
    `CREATE TABLE IF NOT EXISTS ${tables.factEntities} (
       namespace ${key} NOT NULL,
       fact_id ${key} NOT NULL,
       entity ${key} NOT NULL,
       PRIMARY KEY (fact_id, entity)
     )`,
    `CREATE TABLE IF NOT EXISTS ${tables.supersedes} (
       new_fact_id ${key} NOT NULL,
       old_fact_id ${key} NOT NULL,
       PRIMARY KEY (new_fact_id, old_fact_id)
     )`,
    // Every index leads with `namespace`: it is the first predicate in every
    // query, so a tenant's rows stay contiguous and one tenant's size does not
    // slow another's lookups.
    // Supersession lookup: the hot path on every ingested fact.
    `CREATE INDEX IF NOT EXISTS ${tables.facts}_slot_idx
       ON ${tables.facts} (namespace, subject, attribute, status)`,
    // Recall anchors on entity, then orders by time.
    `CREATE INDEX IF NOT EXISTS ${tables.factEntities}_entity_idx
       ON ${tables.factEntities} (namespace, entity)`,
    `CREATE INDEX IF NOT EXISTS ${tables.facts}_observed_at_idx
       ON ${tables.facts} (namespace, observed_at)`,
  ];
}

/** The DDL as one script, for `hymem schema --dialect postgres` or a hand-rolled migration. */
export function schemaScript(dialect: SqlDialect, prefix = "hymem_"): string {
  return createTableStatements(dialect, tableNames(prefix)).map(formatStatement).join("\n\n");
}

/**
 * The statements above are written as indented template literals; strip that
 * source indentation so the emitted DDL is pasteable into a migration file.
 */
function formatStatement(statement: string): string {
  const lines = statement.split("\n");
  const indents = lines
    .slice(1)
    .filter((line) => line.trim())
    .map((line) => line.match(/^ */)?.[0].length ?? 0);
  const commonIndent = indents.length ? Math.min(...indents) : 0;
  const body = lines
    .map((line, index) => (index === 0 ? line : line.slice(commonIndent)))
    .join("\n")
    .trimEnd();
  return `${body};`;
}

export class MissingSchemaError extends Error {
  constructor(tableName: string, dialectName: string, prefix: string) {
    super(
      `hymem: table "${tableName}" does not exist.\n` +
        `Create the schema with one of:\n` +
        `  - pass migrate: "auto" to create it automatically (development)\n` +
        `  - run \`hymem schema --dialect ${dialectName}${prefix === "hymem_" ? "" : ` --prefix ${prefix}`}\` and apply the DDL through your migration tool\n` +
        `  - for Drizzle/Prisma, add hymem's schema to your own schema file so it flows through your normal generate step`,
    );
    this.name = "MissingSchemaError";
  }
}
