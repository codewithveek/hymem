import { createHash } from "node:crypto";

/**
 * Fact identity: the same (subject, attribute, value) inside one namespace is
 * the same fact, whenever it was stated. This is what makes re-ingesting a
 * history idempotent and lets a re-stated fact re-activate rather than
 * duplicate.
 *
 * The namespace is part of the hash, so the same triple in two tenants is two
 * independent facts that supersede separately — and a leaked id cannot address
 * another tenant's row.
 */
export function factId(
  namespace: string,
  subject: string,
  attribute: string,
  value: string,
): string {
  return createHash("sha256")
    .update(unambiguousJoin([namespace, subject, attribute, value].map((field) => field.toLowerCase())))
    .digest("hex")
    .slice(0, 24);
}

/**
 * Join fields into a string that only one field list can produce.
 *
 * A plain `a|b|c` join is not injective: ("a|b", "c") and ("a", "b|c") collapse
 * onto the same string, and since every store upserts on the fact id, that
 * would be one triple silently overwriting another — across namespaces
 * included. Prefixing each field with its length removes the ambiguity: the
 * reader always knows where a field ends without hunting for a delimiter that
 * could just as well be part of the data.
 */
function unambiguousJoin(fields: string[]): string {
  return fields.map((field) => `${field.length}:${field}`).join("|");
}

/**
 * The lookup key for something scoped to a namespace — an entity index entry, a
 * session. Length-prefixed for the same reason fact ids are: with a plain
 * separator, namespace "org 42" + entity "bob" and namespace "org" + entity
 * "42 bob" would be the same key, and one tenant would read the other's rows.
 */
export function scopedKey(namespace: string, key: string): string {
  return unambiguousJoin([namespace, key]);
}

/** The default placeholder an extractor uses for "the human speaking". */
export const DEFAULT_SPEAKER_TOKEN = "user";

/**
 * Entity name for an alias — an alternative way the speaker referred to
 * someone, like "my wife" for "sarah".
 *
 * An alias is stored as an extra entity link on the fact rather than in a
 * lookup table of its own. That means no port change and no adapter work: every
 * store indexes entities already, so `hymem inspect` shows the alias and recall
 * finds it by exact match, with no similarity threshold to tune.
 *
 * Relational aliases are scoped to the speaker because they are only true
 * relative to them — in a shared namespace Alice's "wife" and Bob's "wife" are
 * different people, and an unscoped `wife` entity would merge their facts.
 * Without a speaker the namespace already identifies one person, so the bare
 * form is correct.
 *
 * The `alias:` prefix keeps these out of the way of real entity names; an
 * entity genuinely called "alias:alice/wife" would collide, which is a trade
 * worth making for a name nobody writes.
 */
export function aliasEntity(alias: string, speaker?: string): string {
  const canonical = canonEntity(alias);
  return speaker ? `alias:${canonEntity(speaker)}/${canonical}` : `alias:${canonical}`;
}

export function canonEntity(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function canonAttribute(attr: string): string {
  return attr.trim().toLowerCase();
}
