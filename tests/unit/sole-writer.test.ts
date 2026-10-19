// @vitest-environment node
import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";

/**
 * Mechanical sole-writer invariant: only src/client.ts may import the
 * ingestion functions from src/state/*.ts. Components and other modules
 * read stores via $store auto-subscription but must NEVER write to them
 * directly.
 *
 * WHY THE COVERED SET IS DERIVED, NOT LISTED
 *
 * This test previously hardcoded a 17-name `SOLE_WRITER_FUNCTIONS` set, with
 * a comment instructing contributors to extend it when a store was added.
 * That fails OPEN: a new store's ingestion function is uncovered until
 * somebody remembers, and forgetting is invisible — the suite stays green
 * while the invariant quietly stops applying to the newest code. Measured at
 * the time of this change: 17 names were listed and 81 exported state
 * functions matched the ingestion shape, so ~79% of the write surface was
 * unguarded.
 *
 * The covered set is now DISCOVERED from `src/state/*.ts` and is
 * deny-by-default: every exported state function whose name matches the
 * write-path shape is covered automatically the moment it is written. A new
 * store needs no edit here — which is the property the doctrine requires,
 * since a guard that must be edited when the system grows is itself a defect.
 *
 * The only maintained list is the inverse: `UI_ORIGINATED`, the small set of
 * setters that legitimately belong to the UI rather than to backend
 * ingestion. Adding to it is a deliberate architectural decision that must
 * carry a reason — which is exactly the decision worth surfacing in review.
 */

const SRC_DIR = join(process.cwd(), "src");
const STATE_DIR = join(SRC_DIR, "state");

/** Name shape of a store write-path. */
const INGESTION_SHAPE =
  /^(set|append|update|upsert|ingest|add|replace|merge|record|apply|push|clear|reset|remove|delete)[A-Z]/;

/**
 * Setters that are UI-originated, not backend ingestion, and may therefore be
 * imported by components. Each needs a reason — this list is the escape hatch
 * and it should stay small.
 */
const UI_ORIGINATED: Readonly<Record<string, string>> = Object.freeze({
  // (The old shell's route/theme/debug/density/activation exemptions left
  // with their stores at the cutover — a stale exemption is a claim about
  // a world that no longer exists, and the staleness test below is what
  // forced this trim.)
  clearErrors: "error toasts are dismissed by the user from the ErrorBoundary",
  clearMessages: "clearing the transcript is a user action on the chat surface",
});

/** Every exported function in `src/state/*.ts` matching the write-path shape. */
function discoverStateWriters(): Set<string> {
  const found = new Set<string>();
  for (const entry of readdirSync(STATE_DIR)) {
    if (!entry.endsWith(".ts")) continue;
    const src = readFileSync(join(STATE_DIR, entry), "utf-8");
    for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([a-z][A-Za-z0-9]*)/gm)) {
      const name = m[1]!;
      if (INGESTION_SHAPE.test(name)) found.add(name);
    }
  }
  return found;
}

const DISCOVERED_WRITERS = discoverStateWriters();

/** The covered surface: everything discovered, minus the UI-originated escape hatch. */
const SOLE_WRITER_FUNCTIONS = new Set(
  [...DISCOVERED_WRITERS].filter((n) => UI_ORIGINATED[n] === undefined),
);

// Files exempt from the invariant:
// - src/client.ts — the sole writer
// - src/state/*.ts — the store definitions themselves (they export these)
// - src/client-config.ts — pure constants, no store writes
const EXEMPT_FILES = new Set([
  "src/client.ts",
  "src/client-config.ts",
]);

function walkDir(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkDir(full, acc);
    } else {
      const ext = extname(full);
      if (ext === ".ts" || ext === ".svelte") acc.push(full);
    }
  }
  return acc;
}

function isExempt(absPath: string): boolean {
  const rel = relative(process.cwd(), absPath);
  if (EXEMPT_FILES.has(rel)) return true;
  // State store definitions are exempt (they declare the functions).
  if (absPath.startsWith(STATE_DIR + "/") || absPath.startsWith(STATE_DIR + "\\")) return true;
  return false;
}

/** Extract imported identifiers from an import statement line. */
function extractImports(line: string): string[] {
  // Match: import { a, b as c, type d } from "..."
  const match = line.match(/import\s*(?:type\s*)?\{([^}]*)\}\s*from/);
  if (!match) return [];
  return match[1]!
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/^type\s+/, ""))
    .map((s) => s.split(/\s+as\s+/)[0]!.trim())
    .filter((s) => s.length > 0);
}

describe("sole-writer invariant", () => {
  test("discovery is live and covers the write surface (guard is not vacuous)", () => {
    // If the scan silently matched nothing, every assertion below would be
    // vacuously true. The floor is the surface measured when this guard was
    // made dynamic; it may grow freely and must never collapse.
    expect(
      DISCOVERED_WRITERS.size,
      "no state write-paths discovered — the scan is broken, not the tree",
    ).toBeGreaterThanOrEqual(75);
    expect(
      SOLE_WRITER_FUNCTIONS.size,
      "the covered set collapsed — check UI_ORIGINATED has not been widened wholesale",
    ).toBeGreaterThanOrEqual(70);
  });

  test("every UI_ORIGINATED exemption still exists and still carries a reason", () => {
    // A stale exemption is a silent permission: the function is gone or was
    // renamed, and the entry now excuses nothing while looking deliberate.
    const stale: string[] = [];
    for (const [name, reason] of Object.entries(UI_ORIGINATED)) {
      if (!DISCOVERED_WRITERS.has(name)) {
        stale.push(`${name} — exempted but no longer an exported state write-path`);
      }
      if (reason.trim().length === 0) stale.push(`${name} — exemption has no reason`);
    }
    expect(stale, `Stale UI_ORIGINATED entries:\n${stale.join("\n")}`).toEqual([]);
  });

  test("only src/client.ts imports state ingestion functions", () => {
    const allFiles = walkDir(SRC_DIR);
    const violators: string[] = [];

    for (const file of allFiles) {
      if (isExempt(file)) continue;
      const source = readFileSync(file, "utf-8");
      const lines = source.split("\n");

      for (const line of lines) {
        // Only inspect import lines that reference src/state or../../state
        if (!line.includes("import")) continue;
        if (!line.includes("state/")) continue;

        const imported = extractImports(line);
        for (const name of imported) {
          if (SOLE_WRITER_FUNCTIONS.has(name)) {
            violators.push(
              `${relative(process.cwd(), file)} imports "${name}" (sole-writer function)`,
            );
          }
        }
      }
    }

    expect(violators).toEqual([]);
  });

  test("src/client.ts imports at least one ingestion function (sanity)", () => {
    const clientSource = readFileSync(join(SRC_DIR, "client.ts"), "utf-8");
    const imports = new Set<string>();
    for (const line of clientSource.split("\n")) {
      if (line.includes("import") && line.includes("state/")) {
        for (const name of extractImports(line)) imports.add(name);
      }
    }
    const overlaps = [...imports].filter((n) => SOLE_WRITER_FUNCTIONS.has(n));
    expect(overlaps.length).toBeGreaterThan(0);
  });
});
