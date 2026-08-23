import { createHash } from "node:crypto";

/**
 * Fact identity: same (subject, attribute, value) is the same fact, whenever
 * and wherever it was stated. This is what makes re-ingesting a history
 * idempotent and lets a re-stated fact re-activate rather than duplicate.
 */
export function factId(subject: string, attribute: string, value: string): string {
  return createHash("sha256")
    .update(`${subject}|${attribute}|${value}`.toLowerCase())
    .digest("hex")
    .slice(0, 24);
}

export function canonEntity(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function canonAttribute(attr: string): string {
  return attr.trim().toLowerCase();
}
