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
    .update(`${namespace}|${subject}|${attribute}|${value}`.toLowerCase())
    .digest("hex")
    .slice(0, 24);
}

/** The default placeholder an extractor uses for "the human speaking". */
export const DEFAULT_SPEAKER_TOKEN = "user";

export function canonEntity(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function canonAttribute(attr: string): string {
  return attr.trim().toLowerCase();
}
