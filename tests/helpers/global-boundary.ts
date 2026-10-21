/**
 * SINGLE-PARTY OWNER of the per-file global boundary under `isolate: true`.
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
 * ── Where the snapshot lives, and who fails ──────────────────────────────
 *
 * Vitest RE-EXECUTES setup files for every test file. Module-scope state in
 * `tests/setup/test-setup.ts` is therefore per-FILE, not per-worker — a
 * measured fact: a runtime leak check kept in the setup file reported clean
 * against a deliberately leaking file. The snapshot lives in this ordinary
 * helper module, which the setup imports; under the node project's
 * `isolate: true` it too is fresh for every file, which is exactly the scope
 * the check needs.
 *
 * The file that leaks is the only one that can be blamed, and its own
 * `beforeAll`/`afterAll` always share a registry. So this module compares the
 * file against its OWN entry snapshot and the setup file THROWS at that
 * file's teardown; see {@link assertGlobalsRestored}. A later file cannot
 * identify the culprit — by then its `captureGlobals()` has recorded the
 * leaked stub as its own pristine entry value.
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
 * Put every watched global back to its entry value. Called from the setup
 * file's `afterAll`. Returns the globals this file leaked, already repaired.
 *
 * Repairing AND reporting is deliberate: the repair stops the run cascading
 * into failures that read as bugs in innocent files, and the report stops the
 * repair from hiding the defect.
 */
export function restoreGlobals(): string[] {
  const leaked: string[] = [];
  for (const [name, entryValue] of entryGlobals) {
    if (bag[name] === entryValue) continue;
    leaked.push(name);
    if (entryValue === undefined) delete bag[name];
    else bag[name] = entryValue;
  }
  return leaked;
}

/**
 * THE DOOR THE SETUP FILE'S `afterAll` CALLS: repair the file's globals and
 * FAIL THE FILE if it leaked one.
 *
 * ── Why this is the shape that can fail ──
 * The previous guard asserted `leakedGlobals()` in a test file and relied on
 * a ledger in this module that earlier files appended to in their `afterAll`.
 * Vitest re-executes setup files per test file and, under the node project's
 * `isolate: true`, gives every file a FRESH module registry: the ledger a
 * later file read was always empty, so the assertion could not fail. Worse,
 * the observation was aimed at the wrong place — a file that leaks hands the
 * stub to its successor, but the successor's `captureGlobals()` records the
 * stub as its own entry value, so the victim can never identify it.
 *
 * The file that leaks is the only one that can be blamed, and it can always
 * be blamed: its `beforeAll` snapshot and its `afterAll` comparison live in
 * the SAME registry. So the report belongs at that file's teardown, and it
 * has to THROW: a repair that only logs is a silent repair, and the defect
 * then surfaces as an unrelated failure in the next file.
 *
 * `testFile` is named so the failure says who leaked what. The cleanup the
 * setup owns (temp dirs, env, time travel) runs BEFORE this call so a thrown
 * hook does not strand the worker's state.
 */
export function assertGlobalsRestored(testFile: string): void {
  const leaked = restoreGlobals();
  if (leaked.length === 0) return;
  throw new Error(
    `${testFile} replaced ${leaked.join(", ")} on globalThis and did not restore ` +
      `${leaked.length === 1 ? "it" : "them"}; under the suite's single worker the stub ` +
      `outlives the file and poisons the next one. Capture the original and restore it ` +
      `(or use vi.stubGlobal and vi.unstubAllGlobals).`,
  );
}
