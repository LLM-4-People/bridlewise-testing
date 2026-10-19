/**
 * SINGLE-PARTY OWNER of the per-file global boundary under `isolate: false`.
 *
 * ── The defect this exists to make impossible ────────────────────────────
 *
 * Test files replace globals two different ways, and only one is self-healing:
 *
 *   1. `vi.stubGlobal("fetch", …)` — vitest records the original and
 *      `vi.unstubAllGlobals()` puts it back. Fourteen cockpit files use this.
 *   2. `globalThis.fetch = vi.fn(…)` — a direct assignment. vitest knows
 *      nothing about it, so `unstubAllGlobals()` CANNOT undo it. Nine files
 *      use this shape, each capturing `const realFetch = globalThis.fetch` at
 *      their own module scope and restoring in `afterEach`.
 *
 * Shape 2 carries a chain-of-custody hazard: the "original" each file captures
 * is whatever the PREVIOUS file left behind. A file that leaks a stub does not
 * merely poison its successor — the successor records the stub as pristine and
 * faithfully restores it from then on. The reported symptom is a node-
 * environment file whose own stub should be installed failing with
 * `Failed to parse URL from /api/run/start`: the real undici `fetch` refusing
 * a relative URL, i.e. no stub in place at all.
 *
 * ── Why the bookkeeping lives HERE and not in the setup file ─────────────
 *
 * Vitest RE-EXECUTES setup files for every test file, even under
 * `isolate: false`. Module-scope state in `tests/setup/test-setup.ts`
 * is therefore per-FILE, not per-worker — a leak recorded while file 3 ran is
 * gone by the time file 4's guard reads it. Measured: a runtime leak check
 * kept in the setup file reported clean against a deliberately leaking file.
 *
 * An ordinary helper module is cached per worker, so the ledger of leaks
 * accumulates across the files that share a worker. That is the scope the
 * guard needs.
 */

/**
 * The globals tests actually replace. A watchlist rather than "diff all of
 * `globalThis`" because the jsdom and node environments legitimately differ,
 * and vitest itself installs globals — a blanket diff would report the
 * environment, not the test.
 */
export const WATCHED_GLOBALS = [
  "fetch",
  "EventSource",
  "WebSocket",
  "ResizeObserver",
  "IntersectionObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
] as const;

/** The value each watched global held when the current test file started. */
const entryGlobals = new Map<string, unknown>();

/** `file → global` for every leak seen so far in this worker. */
const leaks: string[] = [];

const bag = globalThis as unknown as Record<string, unknown>;

/**
 * Record the globals a test file inherits. Called from the setup file's
 * `beforeAll`, i.e. after the environment is installed and after the file's
 * own module scope, but before its first test.
 *
 * The comparison is against the file's OWN entry state rather than a
 * worker-wide "pristine" snapshot, because vitest switches environment between
 * files and jsdom supplies globals node does not. Entry-state comparison is
 * environment-agnostic and still guarantees the property that matters: no file
 * hands the next one a global it did not inherit itself.
 */
export function captureGlobals(): void {
  entryGlobals.clear();
  for (const name of WATCHED_GLOBALS) entryGlobals.set(name, bag[name]);
}

/**
 * Put every watched global back to its entry value and record any that moved.
 * Called from the setup file's `afterAll`. Returns the globals this file
 * leaked, already repaired.
 *
 * Repairing AND reporting is deliberate: the repair stops the run cascading
 * into failures that read as bugs in innocent files, and the report stops the
 * repair from hiding the defect.
 */
export function restoreGlobals(testFile: string): string[] {
  const leaked: string[] = [];
  for (const [name, entryValue] of entryGlobals) {
    if (bag[name] === entryValue) continue;
    leaked.push(name);
    leaks.push(`${testFile}: ${name}`);
    if (entryValue === undefined) delete bag[name];
    else bag[name] = entryValue;
  }
  return leaked;
}

/** Every leak seen so far in this worker, as `file: global`. For the guard. */
export function leakedGlobals(): readonly string[] {
  return leaks;
}
