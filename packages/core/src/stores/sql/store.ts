/**
 * MemoryStore over SQL.
 *
 * Four tables, no graph emulation: facts are rows, entities and supersession
 * are join tables, and recall is a join plus an ORDER BY. That the same ten
 * methods land this naturally on tables and on a property graph is the
 * evidence that the port is at the right altitude.
 */
import type { MemoryStore, StoreCapabilities } from "../../core/ports.js";
import type { SearchQuery, SessionRecord, StoredFact } from "../../core/types.js";
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
  /**
   * Override the dialect's bind-parameter cap. Needed only on an unusual build
   * — an old SQLite compiled with SQLITE_MAX_VARIABLE_NUMBER=999, say. Lower is
   * always safe; it just means more round trips.
   */
  maxParameters?: number;
}

interface FactRow {
  id: string;
  namespace: string;
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
  "id, namespace, subject, attribute, value, fact_text, observed_at, session_id, status, valid_from, valid_to";

export function sqlStore(options: SqlStoreOptions): MemoryStore {
  const { driver } = options;
  const { dialect } = driver;
  const prefix = options.tablePrefix ?? "hymem_";
  const tables: TableNames = tableNames(prefix); // validates the prefix
  const migrate: MigrateMode = options.migrate ?? "check";

  const capabilities: StoreCapabilities = {
    vectorSearch: false,
    // True when supersession commits as one unit: a data-modifying CTE
    // (Postgres) or an explicit transaction (SQLite, or any pooled client that
    // can pin a connection). A driver with neither is best-effort.
    atomicSupersede: dialect.dataModifyingCte || driver.transaction !== undefined,
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
  let closing: Promise<void> | undefined;

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
      // Every table is probed, not just `facts`: a half-applied schema that
      // passed here would surface later as a raw driver error from whichever
      // query first touched the missing table, instead of MissingSchemaError
      // and its instructions.
      for (const tableName of Object.values(tables)) {
        try {
          await driver.query(`SELECT 1 FROM ${tableName} LIMIT 1`, []);
        } catch {
          throw new MissingSchemaError(tableName, dialect.name, prefix);
        }
      }
    })();
    await schemaReady;
  }

  const toStoredFact = (row: FactRow, entities: string[]): StoredFact => ({
    id: row.id,
    namespace: row.namespace,
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
  async function withEntities(namespace: string, rows: FactRow[]): Promise<StoredFact[]> {
    if (rows.length === 0) return [];
    const entitiesByFactId = new Map<string, string[]>();
    for (const batch of chunked(rows)) {
      const binder = newBinder();
      const namespaceParam = binder.bind(namespace);
      const idList = binder.list(batch.map((row) => row.id));
      const links = await driver.query<{ fact_id: string; entity: string }>(
        `SELECT fact_id, entity FROM ${tables.factEntities}
         WHERE namespace = ${namespaceParam} AND fact_id IN (${idList})`,
        binder.values,
      );
      for (const link of links) {
        const existing = entitiesByFactId.get(link.fact_id);
        if (existing) existing.push(link.entity);
        else entitiesByFactId.set(link.fact_id, [link.entity]);
      }
    }
    return rows.map((row) => toStoredFact(row, entitiesByFactId.get(row.id) ?? []));
  }

  const ascending = (earlier: StoredFact, later: StoredFact) =>
    earlier.observedAt.localeCompare(later.observedAt);

  const parameterCap = () => options.maxParameters ?? dialect.maxParameters;

  /**
   * Split a list-valued predicate into statements that stay under the dialect's
   * bind-parameter cap. `listFacts` over a large namespace and `deleteFacts`
   * with many ids are both unbounded, and exceeding the cap is a hard driver
   * error rather than a slow query.
   *
   * `reserved` leaves room for the other parameters in the same statement.
   */
  function chunked<T>(items: readonly T[], reserved = 4): T[][] {
    return chunkedTo(items, parameterCap() - reserved);
  }

  /** `chunked`, for callers that have already worked out their own budget. */
  function chunkedTo<T>(items: readonly T[], size: number): T[][] {
    const step = Math.max(1, size);
    if (items.length <= step) return [items as T[]];
    const batches: T[][] = [];
    for (let start = 0; start < items.length; start += step) {
      batches.push(items.slice(start, start + step) as T[]);
    }
    return batches;
  }

  /**
   * The subset of `factIds` this namespace actually owns.
   *
   * Fact ids embed the namespace, so a caller can only produce a foreign one by
   * having seen it — but "unreachable unless leaked" is not a boundary. Every
   * write keyed by a caller-supplied id is narrowed through here first.
   */
  async function ownedFactIds(namespace: string, factIds: readonly string[]): Promise<Set<string>> {
    const owned = new Set<string>();
    if (factIds.length === 0) return owned; // `id IN ()` is not valid SQL
    for (const batch of chunked(factIds)) {
      const binder = newBinder();
      const rows = await driver.query<{ id: string }>(
        `SELECT id FROM ${tables.facts}
         WHERE namespace = ${binder.bind(namespace)} AND id IN (${binder.list(batch)})`,
        binder.values,
      );
      for (const row of rows) owned.add(row.id);
    }
    return owned;
  }

  return {
    capabilities,

    async putSession(namespace: string, session: SessionRecord, previousSessionId?: string) {
      await ensureSchema();
      const binder = newBinder();
      const values = [
        binder.bind(namespace),
        binder.bind(session.id),
        binder.bind(session.ts),
        binder.bind(session.idx),
        binder.bind(previousSessionId ?? null),
        binder.bind(session.speaker ?? null),
      ].join(", ");
      await driver.query(
        `INSERT INTO ${tables.sessions} (namespace, id, ts, session_index, previous_session_id, speaker)
         VALUES (${values})
         ${dialect.upsert(["namespace", "id"], [
           "ts = excluded.ts",
           "session_index = excluded.session_index",
           "previous_session_id = excluded.previous_session_id",
           "speaker = excluded.speaker",
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
          binder.bind(incomingFact.namespace),
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
             (id, namespace, subject, attribute, value, fact_text, observed_at, session_id, status, valid_from, valid_to)
           VALUES (${values}, NULL)
           ${dialect.upsert(["id"], [
             "namespace = excluded.namespace",
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

    async linkEntities(namespace: string, links) {
      await ensureSchema();
      if (links.length === 0) return;
      // A link row stores the caller's namespace beside a fact id it does not
      // verify. Unchecked, one tenant could index another tenant's fact under
      // an entity of its choosing and change what that tenant's own search
      // returns. Unknown and foreign ids are skipped, as in deleteFacts.
      const owned = await ownedFactIds(namespace, [...new Set(links.map((link) => link.factId))]);
      for (const link of links) {
        if (!owned.has(link.factId)) continue;
        const binder = newBinder();
        const values = [
          binder.bind(namespace),
          binder.bind(link.factId),
          binder.bind(link.entity),
        ].join(", ");
        await driver.query(
          `INSERT INTO ${tables.factEntities} (namespace, fact_id, entity) VALUES (${values})
           ${dialect.insertIgnore(["fact_id", "entity"])}`,
          binder.values,
        );
      }
    },

    async supersede(incoming: StoredFact) {
      await ensureSchema();

      /** The predicate selecting facts `incoming` overwrites. */
      const closeClause = (binder: ReturnType<typeof newBinder>) =>
        `UPDATE ${tables.facts}
            SET status = 'superseded', valid_to = ${binder.bind(incoming.observedAt)}
          WHERE namespace = ${binder.bind(incoming.namespace)}
            AND status = 'active'
            AND id <> ${binder.bind(incoming.id)}
            AND subject = ${binder.bind(incoming.subject)}
            AND attribute = ${binder.bind(incoming.attribute)}
            AND value <> ${binder.bind(incoming.value)}
            AND observed_at < ${binder.bind(incoming.observedAt)}
          RETURNING id`;

      // Postgres: close and chain in ONE statement. A data-modifying CTE makes
      // the whole thing a single atomic unit with no window for a second writer.
      if (dialect.dataModifyingCte) {
        const binder = newBinder();
        const closed = closeClause(binder);
        const rows = await driver.query<{ old_fact_id: string }>(
          `WITH closed AS (${closed})
           INSERT INTO ${tables.supersedes} (new_fact_id, old_fact_id)
           SELECT ${binder.bind(incoming.id)}, id FROM closed
           ${dialect.insertIgnore(["new_fact_id", "old_fact_id"])}
           RETURNING old_fact_id`,
          binder.values,
        );
        return rows.map((row) => row.old_fact_id);
      }

      // SQLite and friends: two statements, wrapped so they still commit as one.
      const run = async (transactional: SqlDriver): Promise<string[]> => {
        const closeBinder = newBinder();
        const closedRows = await transactional.query<{ id: string }>(
          closeClause(closeBinder),
          closeBinder.values,
        );
        const supersededIds = closedRows.map((row) => row.id);
        for (const supersededId of supersededIds) {
          const linkBinder = newBinder();
          const values = [linkBinder.bind(incoming.id), linkBinder.bind(supersededId)].join(", ");
          await transactional.query(
            `INSERT INTO ${tables.supersedes} (new_fact_id, old_fact_id) VALUES (${values})
             ${dialect.insertIgnore(["new_fact_id", "old_fact_id"])}`,
            linkBinder.values,
          );
        }
        return supersededIds;
      };

      return driver.transaction ? driver.transaction(run) : run(driver);
    },

    async search(query: SearchQuery) {
      await ensureSchema();
      const limit = Math.floor(query.limit);
      // `limit` is an upper bound, so zero means zero: the reference store
      // returns nothing here and this one has to agree.
      if (query.entities.length === 0 || !Number.isFinite(limit) || limit <= 0) return [];
      const attributes = query.attributes ?? [];

      // Both lists are caller-sized and both bind one parameter per item, so a
      // large query needs splitting exactly as listFacts and deleteFacts do.
      // Every chunk is a relaxation of the same query, so the union of their
      // rows holds every match, and the newest `limit` of that union is what a
      // single unsplittable statement would have returned.
      const budget = Math.max(2, parameterCap() - 2); // room for the namespace
      const attributeBatches = attributes.length
        ? chunkedTo(attributes, Math.floor(budget / 2))
        : [[] as string[]];
      const widestAttributeBatch = Math.max(...attributeBatches.map((batch) => batch.length));
      const entityBatches = chunkedTo(query.entities, budget - widestAttributeBatch);

      const rowsById = new Map<string, FactRow>();
      for (const entityBatch of entityBatches) {
        for (const attributeBatch of attributeBatches) {
          const binder = newBinder();
          const namespaceParam = binder.bind(query.namespace);
          const entityList = binder.list(entityBatch);
          const attributeFilter = attributeBatch.length
            ? `AND facts.attribute IN (${binder.list(attributeBatch)})`
            : "";
          // DESC keeps the NEWEST matches; the result is re-sorted ascending.
          // The join carries the namespace as well: a link row only ever speaks
          // for a fact in its own tenant.
          const rows = await driver.query<FactRow>(
            `SELECT DISTINCT ${FACT_COLUMNS.split(", ").map((column) => `facts.${column}`).join(", ")}
             FROM ${tables.facts} facts
             JOIN ${tables.factEntities} links
               ON links.fact_id = facts.id AND links.namespace = facts.namespace
             WHERE facts.namespace = ${namespaceParam}
               AND links.entity IN (${entityList}) ${attributeFilter}
             ORDER BY facts.observed_at DESC
             LIMIT ${limit}`,
            binder.values,
          );
          for (const row of rows) rowsById.set(row.id, row);
        }
      }

      const newest = [...rowsById.values()]
        .sort((earlier, later) => later.observed_at.localeCompare(earlier.observed_at))
        .slice(0, limit);
      return (await withEntities(query.namespace, newest)).sort(ascending);
    },

    async getSupersededBy(namespace: string, factId: string) {
      await ensureSchema();
      const binder = newBinder();
      const rows = await driver.query<{ value: string; observed_at: string }>(
        `SELECT facts.value, facts.observed_at
         FROM ${tables.supersedes} chain
         JOIN ${tables.facts} facts ON facts.id = chain.old_fact_id
         WHERE chain.new_fact_id = ${binder.bind(factId)}
           AND facts.namespace = ${binder.bind(namespace)}`,
        binder.values,
      );
      return rows.map((row) => ({ value: row.value, observedAt: row.observed_at }));
    },

    async listFacts(namespace: string, entity?: string) {
      await ensureSchema();
      const binder = newBinder();
      const namespaceParam = binder.bind(namespace);
      const rows = entity
        ? await driver.query<FactRow>(
            `SELECT DISTINCT ${FACT_COLUMNS.split(", ").map((column) => `facts.${column}`).join(", ")}
             FROM ${tables.facts} facts
             JOIN ${tables.factEntities} links
               ON links.fact_id = facts.id AND links.namespace = facts.namespace
             WHERE facts.namespace = ${namespaceParam} AND links.entity = ${binder.bind(entity)}
             ORDER BY facts.observed_at`,
            binder.values,
          )
        : await driver.query<FactRow>(
            `SELECT ${FACT_COLUMNS} FROM ${tables.facts}
             WHERE namespace = ${namespaceParam}
             ORDER BY observed_at`,
            binder.values,
          );
      return (await withEntities(namespace, rows)).sort(ascending);
    },

    async deleteFacts(namespace: string, factIds: string[]) {
      await ensureSchema();
      if (factIds.length === 0) return;
      // Narrow to ids this namespace actually owns, so a stray id from another
      // tenant deletes nothing.
      const owned = [...(await ownedFactIds(namespace, factIds))];
      if (owned.length === 0) return;
      // Explicit cascade rather than FK ON DELETE: SQLite enforces foreign
      // keys only when the connection enables them, so doing it here keeps
      // behaviour identical on every engine.
      for (const [table, column] of [
        [tables.factEntities, "fact_id"],
        [tables.supersedes, "new_fact_id"],
        [tables.supersedes, "old_fact_id"],
        [tables.facts, "id"],
      ] as const) {
        for (const batch of chunked(owned)) {
          const binder = newBinder();
          await driver.query(
            `DELETE FROM ${table} WHERE ${column} IN (${binder.list(batch)})`,
            binder.values,
          );
        }
      }
    },

    /** Scoped wipe: other tenants in this store are untouched. */
    async clear(namespace: string) {
      await ensureSchema();
      const chainBinder = newBinder();
      await driver.query(
        `DELETE FROM ${tables.supersedes}
         WHERE new_fact_id IN (
           SELECT id FROM ${tables.facts} WHERE namespace = ${chainBinder.bind(namespace)}
         )`,
        chainBinder.values,
      );
      for (const table of [tables.factEntities, tables.facts, tables.sessions]) {
        const binder = newBinder();
        await driver.query(
          `DELETE FROM ${table} WHERE namespace = ${binder.bind(namespace)}`,
          binder.values,
        );
      }
    },

    async close() {
      // The port promises a second close is safe; the clients underneath do not.
      // pg's pool.end() and node:sqlite's DatabaseSync.close() both throw the
      // second time. Memoise the first call — and drop the memo if it fails, so
      // a close that errored can be retried rather than remembered as done.
      closing ??= driver.close().catch((error: unknown) => {
        closing = undefined;
        throw error;
      });
      await closing;
    },
  };
}
