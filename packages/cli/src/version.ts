/**
 * The package's own version, read rather than written down a second time.
 *
 * Three copies had already drifted: the CLI announced 0.3.0, the MCP server
 * 0.2.0, and package.json — the one npm actually publishes from — said 0.1.2.
 * That is what a literal in the source does. `npm version` has no reason to
 * touch it, so it goes stale the moment anyone releases, and the number a user
 * quotes in a bug report stops meaning anything.
 *
 * `../package.json` resolves identically from `dist/cli.js` and from
 * `src/cli.ts` under tsx: both sit one directory below the package root.
 */
import { readFileSync } from "node:fs";

/** Semver from the manifest, or a marker that says the lookup itself broke. */
export const VERSION: string = readVersion();

/** What VERSION reports when the manifest could not be read or had no version. */
export const UNKNOWN_VERSION = "0.0.0-unknown";

function readVersion(): string {
  try {
    const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return (JSON.parse(manifest) as { version?: string }).version ?? UNKNOWN_VERSION;
  } catch {
    // A missing manifest must not stop the CLI from running — `hymem ingest`
    // does not care what version it is. Reporting the failure honestly beats
    // both crashing and inventing a number.
    return UNKNOWN_VERSION;
  }
}
