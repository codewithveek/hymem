/**
 * MemoryStore over SQL.
 *
 * Four tables, no graph emulation: facts are rows, entities and supersession
 * are join tables, and recall is a join plus an ORDER BY. That the same nine
 * methods land this naturally on tables and on a property graph is the
 * evidence that the port is at the right altitude.
 */
import type { MemoryStore, StoreCapabilities } from "../../core/ports.js";
import type { FactKey, SearchQuery, SessionRecord, StoredFact } from "../../core/types.js";
import type { SqlDriver } from "./driver.js";
import {
  createTableStatements,
  MissingSchemaError,
  tableNames,
  type MigrateMode,
  type TableNames,
} from "./schema.js";

export interface SqlStoreOptions {
  driver: SqlDriver;
  /** How the schema reaches the database. Default "check". */
  migrate?: MigrateMode;
  /** Table-name prefix, so hymem never collides with your own `facts` table. */
  tablePrefix?: string;
}

interface FactRow {
  id: string;
  subject: string;
  attribute: string;
  value: string;
  fact_text: string;
  observed_at: string;
  session_id: string;
  status: string;
  valid_from: string;
  valid_to: string | null;
}

const FACT_COLUMNS =
  "id, subject, attribute, value, fact_text, observed_at, session_id, status, valid_from, valid_to";

export function sqlStore(options: SqlStoreOptions): MemoryStore {
  const { driver } = options;
  const { dialect } = driver;
  const prefix = options.tablePrefix ?? "hymem_";
  const tables: TableNames = tableNames(prefix);
  const migrate: MigrateMode = options.migrate ?? "check";

  const capabilities: StoreCapabilities = {
    vectorSearch: false,
    // The supersession trio is three statements; wrapping it in a transaction
    // is a natural next step for this adapter but is not done yet.
    transactions: false,
  };

  /**
   * Bind-parameter builder. Postgres numbers its placeholders and SQLite does
   * not, so parameters are accumulated in order and rendered by the dialect.
   */
  function newBinder() {
    const values: unknown[] = [];
    return {
      values,
      bind(value: unknown): string {
        values.push(value);
        return dialect.placeholder(values.length);
      },
      list(items: readonly unknown[]): string {
        return items.map((item) => this.bind(item)).join(", ");
      },
    };
  }

  let schemaReady: Promise<void> | undefined;

  async function ensureSchema(): Promise<void> {
    if (migrate === "off") return;
    schemaReady ??= (async () => {
      if (migrate === "auto") {
        for (const statement of createTableStatements(dialect, tables)) {
          await driver.query(statement, []);
        }
        return;
      }
      // "check": a probe select is dialect-free, unlike information_schema.
      try {
        await driver.query(`SELECT 1 FROM ${tables.facts} LIMIT 1`, []);
      } catch {
        throw new MissingSchemaError(tables.facts, dialect.name, prefix);
      }
    })();
    await schemaReady;
  }

  const toStoredFact = (row: FactRow, entities: string[]): StoredFact => ({
    id: row.id,
    subject: row.subject,
    attribute: row.attribute,
    value: row.value,
    text: row.fact_text,
    entities,
    observedAt: row.observed_at,
    sessionId: row.session_id,
    status: row.status === "superseded" ? "superseded" : "active",
    validFrom: row.valid_from,
    validTo: row.valid_to ?? null,
  });

  /**
   * Attach entities to fact rows with one extra query rather than an
   * aggregate, since string_agg/group_concat spelling differs per engine.
   */
  async function withEntities(rows: FactRow[]): Promise<StoredFact[]> {
    if (rows.length === 0) return [];
    const binder = newBinder();
    const idList = binder.list(rows.map((row) => row.id));
    const links = await driver.query<{ fact_id: string; entity: string }>(
      `SELECT fact_id, entity FROM ${tables.factEntities} WHERE fact_id IN (${idList})`,
      binder.values,
    );
    const entitiesByFactId = new Map<string, string[]>();
    for (const link of links) {
      const existing = entitiesByFactId.get(link.fact_id);
      if (existing) existing.push(link.entity);
      else entitiesByFactId.set(link.fact_id, [link.entity]);
    }
    return rows.map((row) => toStoredFact(row, entitiesByFactId.get(row.id) ?? []));
  }

  const ascending = (earlier: StoredFact, later: StoredFact) =>
    earlier.observedAt.localeCompare(later.observedAt);

  return {
    capabilities,

    async putSession(session: SessionRecord, previousSessionId?: string) {
      await ensureSchema();
      const binder = newBinder();
      const values = [
        binder.bind(session.id),
        binder.bind(session.ts),
        binder.bind(session.idx),
        binder.bind(previousSessionId ?? null),
      ].join(", ");
      await driver.query(
        `INSERT INTO ${tables.sessions} (id, ts, session_index, previous_session_id)
         VALUES (${values})
         ${dialect.upsert(["id"], [
           "ts = excluded.ts",
           "session_index = excluded.session_index",
           "previous_session_id = excluded.previous_session_id",
         ])}`,
        binder.values,
      );
    },

    async putFacts(incomingFacts: StoredFact[]) {
      await ensureSchema();
      if (incomingFacts.length === 0) return;
      for (const incomingFact of incomingFacts) {
        const binder = newBinder();
        const values = [
          binder.bind(incomingFact.id),
          binder.bind(incomingFact.subject),
          binder.bind(incomingFact.attribute),
          binder.bind(incomingFact.value),
          binder.bind(incomingFact.text),
          binder.bind(incomingFact.observedAt),
          binder.bind(incomingFact.sessionId),
          binder.bind("active"),
          binder.bind(incomingFact.observedAt),
        ].join(", ");
        // Re-activation is the whole point of the DO UPDATE: a fact restated
        // after being superseded goes back to active, validFrom is refreshed,
        // and validTo is cleared.
        await driver.query(
          `INSERT INTO ${tables.facts}
             (id, subject, attribute, value, fact_text, observed_at, session_id, status, valid_from, valid_to)
           VALUES (${values}, NULL)
           ${dialect.upsert(["id"], [
             "subject = excluded.subject",
             "attribute = excluded.attribute",
             "value = excluded.value",
             "fact_text = excluded.fact_text",
             "observed_at = excluded.observed_at",
             "session_id = excluded.session_id",
             "status = 'active'",
             "valid_from = excluded.valid_from",
             "valid_to = NULL",
           ])}`,
          binder.values,
        );
      }
    },

    async linkEntities(links) {
      await ensureSchema();
      if (links.length === 0) return;
      for (const link of links) {
        const binder = newBinder();
        const values = [binder.bind(link.factId), binder.bind(link.entity)].join(", ");
        await driver.query(
          `INSERT INTO ${tables.factEntities} (fact_id, entity) VALUES (${values})
           ${dialect.insertIgnore(["fact_id", "entity"])}`,
          binder.values,
        );
      }
    },

    async findSupersedable(key: FactKey & { before: string; excludeId: string }) {
      await ensureSchema();
      const binder = newBinder();
      const rows = await driver.query<{ id: string }>(
        `SELECT id FROM ${tables.facts}
         WHERE status = 'active'
           AND id <> ${binder.bind(key.excludeId)}
           AND subject = ${binder.bind(key.subject)}
           AND attribute = ${binder.bind(key.attribute)}
           AND value <> ${binder.bind(key.value)}
           AND observed_at < ${binder.bind(key.before)}`,
        binder.values,
      );
      return rows.map((row) => row.id);
    },

    async closeFacts(factIds: string[], validTo: string) {
      await ensureSchema();
      if (factIds.length === 0) return;
      const binder = newBinder();
      const validToPlaceholder = binder.bind(validTo);
      const idList = binder.list(factIds);
      await driver.query(
        `UPDATE ${tables.facts}
         SET status = 'superseded', valid_to = ${validToPlaceholder}
         WHERE id IN (${idList})`,
        binder.values,
      );
    },

    async linkSupersedes(newFactId: string, supersededFactIds: string[]) {
      await ensureSchema();
      for (const supersededId of supersededFactIds) {
        const binder = newBinder();
        const values = [binder.bind(newFactId), binder.bind(supersededId)].join(", ");
        await driver.query(
          `INSERT INTO ${tables.supersedes} (new_fact_id, old_fact_id) VALUES (${values})
           ${dialect.insertIgnore(["new_fact_id", "old_fact_id"])}`,
          binder.values,
        );
      }
    },

    async search(query: SearchQuery) {
      await ensureSchema();
      if (query.entities.length === 0) return [];
      const binder = newBinder();
      const entityList = binder.list(query.entities);
      const attributes = query.attributes ?? [];
      const attributeFilter = attributes.length
        ? `AND facts.attribute IN (${binder.list(attributes)})`
        : "";
      const limit = Math.max(1, Math.floor(query.limit));
      // DESC keeps the NEWEST matches; the result is re-sorted ascending.
      const rows = await driver.query<FactRow>(
        `SELECT DISTINCT ${FACT_COLUMNS.split(", ").map((column) => `facts.${column}`).join(", ")}
         FROM ${tables.facts} facts
         JOIN ${tables.factEntities} links ON links.fact_id = facts.id
         WHERE links.entity IN (${entityList}) ${attributeFilter}
         ORDER BY facts.observed_at DESC
         LIMIT ${limit}`,
        binder.values,
      );
      return (await withEntities(rows)).sort(ascending);
    },

    async getSupersededBy(factId: string) {
      await ensureSchema();
      const binder = newBinder();
      const rows = await driver.query<{ value: string; observed_at: string }>(
        `SELECT facts.value, facts.observed_at
         FROM ${tables.supersedes} chain
         JOIN ${tables.facts} facts ON facts.id = chain.old_fact_id
         WHERE chain.new_fact_id = ${binder.bind(factId)}`,
        binder.values,
      );
      return rows.map((row) => ({ value: row.value, observedAt: row.observed_at }));
    },

    async listFacts(entity?: string) {
      await ensureSchema();
      const binder = newBinder();
      const rows = entity
        ? await driver.query<FactRow>(
            `SELECT DISTINCT ${FACT_COLUMNS.split(", ").map((column) => `facts.${column}`).join(", ")}
             FROM ${tables.facts} facts
             JOIN ${tables.factEntities} links ON links.fact_id = facts.id
             WHERE links.entity = ${binder.bind(entity)}
             ORDER BY facts.observed_at`,
            binder.values,
          )
        : await driver.query<FactRow>(
            `SELECT ${FACT_COLUMNS} FROM ${tables.facts} ORDER BY observed_at`,
            [],
          );
      return (await withEntities(rows)).sort(ascending);
    },

    async deleteFacts(factIds: string[]) {
      await ensureSchema();
      if (factIds.length === 0) return;
      // Explicit cascade rather than FK ON DELETE: SQLite enforces foreign
      // keys only when the connection enables them, so doing it here keeps
      // behaviour identical on every engine.
      for (const [table, column] of [
        [tables.factEntities, "fact_id"],
        [tables.supersedes, "new_fact_id"],
        [tables.supersedes, "old_fact_id"],
        [tables.facts, "id"],
      ] as const) {
        const binder = newBinder();
        await driver.query(
          `DELETE FROM ${table} WHERE ${column} IN (${binder.list(factIds)})`,
          binder.values,
        );
      }
    },

    async clear() {
      await ensureSchema();
      for (const table of [tables.supersedes, tables.factEntities, tables.facts, tables.sessions]) {
        await driver.query(`DELETE FROM ${table}`, []);
      }
    },

    async close() {
      await driver.close();
    },
  };
}
