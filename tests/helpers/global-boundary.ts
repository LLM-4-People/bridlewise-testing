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
 * ── The TWO observations the old shape could not make ────────────────────
 *
 * A finite watchlist (`fetch`, `EventSource`, …) misses every global it does
 * not name. A module-scope leak misses even a watched one: `captureGlobals()`
 * used to run from the setup file's `beforeAll`, which fires AFTER the test
 * file's module body, so a `globalThis.fetch = fake` written at module scope
 * was stored as that file's pristine entry value. And a bracket / computed
 * write, `(globalThis as any)["fetch"] = fake`, was invisible to the static
 * scan's `globalThis.\w+ =` pattern.
 *
 * So the snapshot is taken from the setup MODULE's own scope (before vitest
 * imports the test file) and is a descriptor snapshot of EVERY own property of
 * `globalThis`, not a list of names. A replacement is a changed descriptor,
 * whether it was spelled with a dot, a bracket or a computed key.
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

/** One own property of `globalThis` as it stood when the file started. */
type GlobalDescriptor = PropertyDescriptor;

/** Every own property descriptor, keyed by property name or symbol. */
const entryDescriptors = new Map<PropertyKey, GlobalDescriptor>();

function snapshotDescriptors(): Map<PropertyKey, GlobalDescriptor> {
  const descriptors = Object.getOwnPropertyDescriptors(globalThis) as Record<PropertyKey, GlobalDescriptor>;
  return new Map(Reflect.ownKeys(descriptors).map((key) => [key, descriptors[key]!]));
}

/**
 * Record the complete `globalThis` state a test file inherits. Called from the
 * setup file's module scope, i.e. before vitest imports the test file.
 *
 * The comparison is against the file's OWN entry state rather than a
 * worker-wide "pristine" snapshot, because vitest switches environment between
 * files and jsdom supplies globals node does not. Entry-state comparison is
 * environment-agnostic and still guarantees the property that matters: no file
 * hands the next one a global it did not inherit itself.
 */
export function captureGlobals(): void {
  initialisePlatformFetchGlobals();
  entryDescriptors.clear();
  for (const [name, descriptor] of snapshotDescriptors()) entryDescriptors.set(name, descriptor);
}

/**
 * Force Node's LAZY platform-fetch module to register its globals BEFORE the
 * snapshot.
 *
 * Node brings up undici (`fetch`, `Headers`, `Request`, …) on first use, and
 * that initialisation installs two own SYMBOL properties on `globalThis`
 * (`Symbol.for("undici.globalDispatcher.1")` and `…2`). They therefore used to
 * appear between the setup snapshot and the first test. The door excused every
 * NEW symbol-named property to tolerate that, and the excuse also covered a
 * symbol a test installed at module scope — a leaked global nobody reported.
 *
 * Constructing a platform fetch primitive initialises the same lazy module
 * before the snapshot is taken (measured on node 24.20: exactly the two
 * dispatcher symbols, no other property). The symbols are then part of the
 * file's ENTRY state, so the comparison below needs no symbol special case:
 * every key, string or symbol, is judged by its descriptor. Importing the
 * `undici` package later in a test only re-confirms the same values.
 *
 * Best-effort because a DOM test environment may not expose `Headers`; if it
 * does not, Node's lazy module is not what installs the property and there is
 * nothing to pre-initialise.
 */
function initialisePlatformFetchGlobals(): void {
  const HeadersConstructor = (globalThis as { Headers?: new () => unknown }).Headers;
  if (typeof HeadersConstructor !== "function") return;
  try {
    new HeadersConstructor();
  } catch {
    // An environment whose Headers cannot be constructed is not proof either
    // way; the descriptor comparison below is still the verdict owner.
  }
}

/**
 * Symbols the PLATFORM toolchain registers on `globalThis` through the global
 * symbol registry, not tests.
 *
 * `Symbol.for("signal-exit emitter")` is installed by rolldown's bundled
 * signal-exit when the bundler's watch module loads — which happens in a file
 * that reads the Vite config, not in the test's own code. It arrives after the
 * entry snapshot, so the boundary used to blame the file that happened to load
 * the bundler. The key is registry-global, so a test cannot get a private one,
 * and a test that sets this key is still judged by its descriptor; this set
 * only names the keys the platform owns.
 */
const PLATFORM_REGISTERED_SYMBOLS: ReadonlySet<symbol> = new Set([
  Symbol.for("signal-exit emitter"),
  Symbol.for("graceful-fs.queue"),
]);

/**
 * The ONE declared exception: a fixture whose SUBJECT is the leak itself.
 *
 * The isolation contract plants a symbol and an env var and then proves the
 * next file starts clean; failing the planter would make the contract report a
 * failure for the leak it deliberately created. The marker is a registry
 * symbol set at the fixture's MODULE load (an environment variable set inside
 * a test is restored by the env door before this one reads it). The door still
 * REPAIRS the globals — the run is not poisoned — it only does not fail that
 * file, and it does not report the marker itself.
 */
const DECLARED_LEAK_MARKER = Symbol.for("bridlewise.global-boundary.allow-leak");

function sameDescriptor(left: GlobalDescriptor | undefined, right: GlobalDescriptor | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    Object.is(left.value, right.value) &&
    Object.is(left.get, right.get) &&
    Object.is(left.set, right.set) &&
    left.writable === right.writable &&
    left.enumerable === right.enumerable &&
    left.configurable === right.configurable
  );
}

/**
 * Put every own property of `globalThis` back to its entry descriptor. Called
 * from the setup file's `afterAll`. Returns the properties this file changed,
 * already repaired where the runtime allows a repair.
 *
 * Repairing AND reporting is deliberate: the repair stops the run cascading
 * into failures that read as bugs in innocent files, and the report stops the
 * repair from hiding the defect. A property the runtime refuses to repair is
 * still reported.
 */
export function restoreGlobals(): PropertyKey[] {
  const changed: PropertyKey[] = [];
  const current = snapshotDescriptors();
  const names = [...new Set<PropertyKey>([...entryDescriptors.keys(), ...current.keys()])].sort((a, b) =>
    String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
  for (const name of names) {
    const before = entryDescriptors.get(name);
    const now = current.get(name);
    if (sameDescriptor(before, now)) continue;
    // A symbol the PLATFORM toolchain registered after the entry snapshot is
    // not this file's leak: loading the bundler's watch module installs
    // `Symbol.for("signal-exit emitter")` as a side effect. It is repaired
    // below like any other, but not reported against the file.
    const platformInstalled =
      before === undefined &&
      typeof name === "symbol" &&
      (PLATFORM_REGISTERED_SYMBOLS.has(name) || name === DECLARED_LEAK_MARKER);
    if (!platformInstalled) changed.push(name);
    try {
      if (before === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, before);
    } catch {
      // A non-configurable accessor cannot be redefined. The leak is still
      // reported; there is no repair the language permits.
      if (before !== undefined && "value" in before) {
        try {
          (globalThis as unknown as Record<PropertyKey, unknown>)[name] = before.value;
        } catch {
          // Reported below either way.
        }
      }
    }
  }
  return changed;
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
 * be blamed: its module-scope snapshot and its `afterAll` comparison live in
 * the SAME registry. So the report belongs at that file's teardown, and it
 * has to THROW: a repair that only logs is a silent repair, and the defect
 * then surfaces as an unrelated failure in the next file.
 *
 * `testFile` is named so the failure says who leaked what. The cleanup the
 * setup owns (temp dirs, env, time travel) runs BEFORE this call so a thrown
 * hook does not strand the worker's state.
 */
export function assertGlobalsRestored(testFile: string): void {
  // Read the fixture's declaration BEFORE the repair: the marker itself is a
  // property this file added, so `restoreGlobals` removes it.
  const declaredLeak = (globalThis as Record<symbol, unknown>)[DECLARED_LEAK_MARKER] === true;
  const leaked = restoreGlobals();
  if (leaked.length === 0) return;
  if (declaredLeak) return;
  const shown = leaked.slice(0, 10).map(String).join(", ") + (leaked.length > 10 ? ", …" : "");
  throw new Error(
    `${testFile} changed ${shown} on globalThis and did not restore ` +
      `${leaked.length === 1 ? "it" : "them"}; under the suite's single worker the stub ` +
      `outlives the file and poisons the next one. Capture the original and restore it ` +
      `(or use vi.stubGlobal and vi.unstubAllGlobals).`,
  );
}
