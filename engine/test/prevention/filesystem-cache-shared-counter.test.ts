// Prevention test for the filesystem-backed shared write counter.
//
// The serial test phase uses process isolation (each serial file runs in its
// own node process), so an in-memory counter is per-process and NOT shared.
// A per-process counter allowed the shared cache directory to grow to
// N × cap files before any process trims (N = serial process count) — a
// latent unbounded-growth bug. The fix is a filesystem-backed shared counter
// (a counter file in the cache directory that all processes increment
// atomically via appendFileSync). The trim fires after `cap` TOTAL writes
// across all processes, not `cap` writes per process.
//
// This test simulates N processes by creating N cache instances pointing to
// the same shared directory (each instance is like a new process since the
// counter is filesystem-backed, not in-memory). With the OLD per-process
// counter, each instance's in-memory counter starts at 0, so N instances
// each writing 1 entry never trigger a trim (each counter = 1 < cap). With
// the NEW filesystem counter, the shared counter reaches `cap` after `cap`
// total writes, triggering a trim regardless of how many processes wrote.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import {
  bodyCalls,
  callArgumentsOf,
  enclosingFunctionOf,
  functionBody,
} from "../../src/shared/source-structure.ts";
import { analysisSemanticsId, createFilesystemCache, createSharedWriteCounter } from "../../scripts/verification/filesystem-cache.ts";
import { readSourceView, sourceViewOf } from "../../scripts/verification/source-view.ts";
import { analyzeArchitectureSource, clearArchitectureSourceCache } from "../../scripts/verification/architecture.ts";
import { clearGovernedSourceParseCache, verifyGovernedTypeScriptSource } from "../../scripts/tooling/verification/governed-source.ts";
import { canonicalHash, canonicalJson, sha256 } from "../../src/kernel/integrity.ts";
import {
  DEFAULT_ARCHITECTURE_SOURCE_FILESYSTEM_CACHE_MAX_ENTRIES,
  DEFAULT_GOVERNED_SOURCE_VIOLATIONS_FILESYSTEM_CACHE_MAX_ENTRIES,
} from "../../src/workflow/workflow-config.ts";
import { createTempDir, systemTempRoot } from "../support/temp-dir.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

// NOTE: `createFilesystemCache` takes a cache NAME and creates the directory
// under os.tmpdir() itself — the directory is created by PRODUCTION code
// (src/…/filesystem cache), not by this test, so the test cannot route its
// creation through the temp-dir owner. What the test owns is the removal,
// which the `finally` blocks below do. `systemTempRoot()` is the owner's
// path-only accessor: it builds the path production will use, creating
// nothing. See the report note on this production temp-dir behaviour.
const TEST_CACHE_DIR = `harness-test-fs-cache-${randomBytes(8).toString("hex")}`;

function uniqueCacheDirectory(): string {
  return join(systemTempRoot(), TEST_CACHE_DIR);
}

function countCacheFiles(directory: string): number {
  if (!existsSync(directory)) return 0;
  return readdirSync(directory).filter((name) => name.endsWith(".json")).length;
}

test("filesystem cache shared counter: trim fires after cap TOTAL writes, not cap per process", () => {
  const directory = uniqueCacheDirectory();
  const cap = 5;
  try {
    // Simulate `4 × cap` processes, each writing 1 entry. Each
    // createFilesystemCache call is a new instance with its own in-memory
    // state (like a new process). The shared counter is filesystem-backed.
    const processCount = 4 * cap;
    let maxFiles = 0;
    for (let process = 0; process < processCount; process += 1) {
      const cache = createFilesystemCache({ directory: TEST_CACHE_DIR, maxEntries: cap });
      cache.write(`process-${process}`, { value: process });
      maxFiles = Math.max(maxFiles, countCacheFiles(directory));
    }
    // The amortized trim bound is ~2 × cap: the trim fires every `cap`
    // TOTAL writes, and between trims the directory grows by `cap` files
    // (from `cap` to `2 × cap`, then trimmed back to `cap`). So the max is
    // `2 × cap - 1` (just before a trim). With the per-process counter,
    // each instance's counter = 1 (no trim, since 1 < cap), so the
    // directory grows to `processCount` files with NO trim — unbounded.
    // The shared counter bounds it to ~`2 × cap` regardless of process
    // count. Allow a small slack for the race between the statSync (which
    // decides to trim) and the unlink (concurrent appends between the
    // statSync and the trim completion are counted but not yet trimmed).
    const amortizedBound = 2 * cap;
    const slack = 2;
    assert.ok(
      maxFiles <= amortizedBound + slack,
      `cache directory grew to ${maxFiles} files (amortized bound=${amortizedBound}, cap=${cap}) — the shared counter did not bound the cache; a per-process counter would grow to ${processCount}`,
    );
    // The directory must be bounded at the END too (the last trim may have
    // fired on the last write).
    const finalFiles = countCacheFiles(directory);
    assert.ok(
      finalFiles <= amortizedBound + slack,
      `final cache directory has ${finalFiles} files (amortized bound=${amortizedBound}, cap=${cap}) — the trim did not bring it back under the bound`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("filesystem cache shared counter: the counter is filesystem-backed (a .write-counter file exists)", () => {
  const directory = uniqueCacheDirectory();
  const cap = 3;
  try {
    const cache = createFilesystemCache({ directory: TEST_CACHE_DIR, maxEntries: cap });
    cache.write("key-1", { v: 1 });
    const counterPath = join(directory, ".write-counter");
    assert.ok(
      existsSync(counterPath),
      "the shared write counter file (.write-counter) must exist after a write — it is the filesystem-backed shared counter (not an in-memory per-process variable)",
    );
    // The counter file size IS the counter. After 1 write, the size must be
    // at least 1 (one byte appended). It may be more if a prior test left
    // a counter (unlikely — unique directory), so check >= 1.
    const size = statSync(counterPath).size;
    assert.ok(size >= 1, `counter file size must be >= 1 after a write (got ${size})`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("filesystem cache shared counter: the counter is shared across instances (not per-process)", () => {
  // The decisive test: with a per-process in-memory counter, instance B
  // starts with counter = 0 regardless of instance A's writes. With the
  // filesystem-backed counter, instance B inherits A's counter (the counter
  // is in the shared file). So if A writes `cap - 1` entries (counter =
  // cap - 1, no trim), then B writes 1 entry, the shared counter reaches
  // `cap` and trim fires. With a per-process counter, B's counter = 1 (no
  // trim), and the directory grows to `cap` files with no trim.
  const directory = uniqueCacheDirectory();
  const cap = 4;
  try {
    const cacheA = createFilesystemCache({ directory: TEST_CACHE_DIR, maxEntries: cap });
    // A writes `cap - 1` entries (counter = cap - 1, no trim).
    for (let i = 0; i < cap - 1; i += 1) {
      cacheA.write(`a-key-${i}`, { v: i });
    }
    const filesBeforeB = countCacheFiles(directory);
    assert.equal(filesBeforeB, cap - 1, "A's writes should produce cap - 1 files (no trim yet)");

    // B is a new instance (simulating a new process). With the per-process
    // counter, B's counter = 0. With the filesystem counter, B inherits
    // the shared counter (cap - 1).
    const cacheB = createFilesystemCache({ directory: TEST_CACHE_DIR, maxEntries: cap });
    // B writes 1 entry. Shared counter = cap, trim fires. Per-process
    // counter = 1, no trim.
    cacheB.write("b-key-0", { v: 0 });

    // With the shared counter, the trim fired. The counter file must have
    // been reset (size small) after the trim.
    const counterPath = join(directory, ".write-counter");
    assert.ok(existsSync(counterPath), "counter file must exist");
    const counterSizeAfterB = statSync(counterPath).size;
    // After the trim, the counter is reset to 0 (or a small value if B
    // appended after the reset). It must NOT be `cap` (which would mean the
    // reset did not happen).
    assert.ok(
      counterSizeAfterB < cap,
      `counter must be reset after trim (size=${counterSizeAfterB}, cap=${cap}) — a per-process counter would not reset`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("filesystem cache shared counter: createSharedWriteCounter is exported + callable", () => {
  // Verify the shared counter helper is exported (so the S1 cache + the
  // generic createFilesystemCache can both use it — DRY, one owner).
  const directory = createTempDir("harness-test-counter-");
  try {
    mkdirSync(directory, { recursive: true });
    const counter = createSharedWriteCounter(directory, 3);
    assert.equal(typeof counter.increment, "function", "increment must be a function");
    assert.equal(typeof counter.reset, "function", "reset must be a function");
    // Increment 3 times; the 3rd should return true (counter >= cap).
    assert.equal(counter.increment(), false, "first increment should not trigger trim (1 < 3)");
    assert.equal(counter.increment(), false, "second increment should not trigger trim (2 < 3)");
    assert.equal(counter.increment(), true, "third increment should trigger trim (3 >= 3)");
    counter.reset();
    const size = statSync(join(directory, ".write-counter")).size;
    assert.equal(size, 0, "reset must truncate the counter file to 0 bytes");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ── Deny-by-default discovery: EVERY cache uses the shared counter ─────────
//
// The behavioural tests above prove the shared counter works. What they do
// not prove is that every cache USES it: a new filesystem cache written
// tomorrow — or an inline cache that never went through createFilesystemCache
// — could reintroduce a per-process in-memory counter and with it the
// unbounded-growth bug (N processes × cap files before any process trims).
// These arms discover the whole population dynamically and refuse the class:
//
//   A — the OWNER's wiring: createFilesystemCache itself builds its trim
//       trigger from createSharedWriteCounter (string-level mutation proves
//       the arm is not vacuous).
//   B — every createFilesystemCache call site across src/ + scripts/ (AST
//       discovery, liveness-asserted). These are safe by construction given
//       arm A; the arm's job is to keep the population visible.
//   C — INLINE caches: any module with the eviction signature (readdirSync +
//       unlinkSync) that gates its trim on a mutable in-memory counter
//       (declared zero, mutated, threshold-compared) is refused. A cache
//       that prunes from a FRESH directory listing (compile-cache.ts) has no
//       such counter and stays green.
//   D — the counter file name (.write-counter) appears in the owner and
//       nowhere else: a second counter file is a second counter.
//   E — the analysis-cache KEY SALT: every createFilesystemCache call site
//       derives its key through analysisSemanticsId (the analyzer's own
//       bytes hashed into the key), or carries a documented
//       @unsalted-cache-key reason for being exempt while its own salting
//       change is pending. A cache keyed by content alone serves entries
//       written before the analyzer's behavior changed, masking the change
//       — the stale-key class a real poisoned entry demonstrated live on
//       the lexical shape cache. The behavioural proof for the salted
//       members is the planted-stale-entry arm below; this census keeps
//       the population honest so a new analysis cache cannot arrive
//       unsalted and silent.
//   F — the unreadable-analyzer fallback: where the analyzer's bytes
//       cannot be read, the salt degrades to a constant no real salt can
//       equal, so the cache read fails (a miss, fresh computation) rather
//       than serving an entry whose producing analyzer cannot be
//       confirmed.
//
// LADDER VERDICT: rung 5 (source scan), and the stop is specific.
//   Rung 1 unavailable — a counter variable is not an OS object.
//   Rung 2 unavailable — the type system cannot express "this number is
//     shared across processes".
//   Rung 3 partially available and NOT taken for the same recorded reason as
//     the cache-directory uniqueness ladder (keying the config by directory
//     collides with runtime-built test directories).
//   Rung 4 unavailable — createFilesystemCache cannot see inline caches that
//     never call it; there is no door they all pass through.
//   The scan's universe is the whole tree (src/ + scripts/, discovered, not
//   listed), and every detector is driven by planted records in this file.

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(MODULE_DIR, "..", "..");
const CACHE_OWNER_PATH = join(REPO_ROOT, "scripts", "verification", "filesystem-cache.ts");

interface SourceRecord {
  readonly path: string;
  readonly source: string;
}

/** Every `.ts` source under src/ and scripts/ (tests excluded), read once. */
function discoverEngineSources(): SourceRecord[] {
  return ["src", "scripts"]
    .flatMap((root) => walk(join(REPO_ROOT, root), { exts: [".ts"] }))
    .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".d.ts"))
    .map((path) => ({ path, source: readFileSync(path, "utf8") }));
}

const rel = (path: string): string => relative(REPO_ROOT, path).replaceAll("\\", "/");

/** Arm A: violations in the OWNER's wiring (empty when correctly wired). */
function ownerWiringViolations(ownerSource: string): string[] {
  const violations: string[] = [];
  const body = functionBody(ownerSource, "createFilesystemCache");
  if (!bodyCalls(body, "createSharedWriteCounter")) {
    violations.push(
      "createFilesystemCache no longer builds its trim trigger from createSharedWriteCounter — " +
      "a per-process counter here is the unbounded-growth bug this file exists to prevent",
    );
  }
  if (!bodyCalls(body, "counter.increment")) {
    violations.push(
      "createFilesystemCache creates the shared counter but never gates a trim on counter.increment() — " +
      "the counter is computed and discarded, which is the inert shape of the same bug",
    );
  }
  return violations;
}

/**
 * Build a wiring mutation of the owner source, proving first that the anchor
 * exists IN THE CODE VIEW (not merely in a comment or string). The read the
 * caller hands over is parser input; the QUESTION about it is answered
 * through the sanctioned view.
 */
function mutateOwnerSource(ownerSource: string, from: string, to: string): string {
  assert.ok(
    sourceViewOf(ownerSource, CACHE_OWNER_PATH).code().includes(from),
    `the mutation anchor must exist in the owner source: ${from}`,
  );
  return ownerSource.replace(from, to);
}

/** The owner's text, read once per test that needs parser input. */
function readOwnerSource(): string {
  return readFileSync(CACHE_OWNER_PATH, "utf8");
}

/** The eviction signature, asked of the code view rather than raw bytes. */
function isEvictionBearing(file: SourceRecord): boolean {
  if (file.path === CACHE_OWNER_PATH) return false;
  const code = sourceViewOf(file.source, rel(file.path)).code();
  return code.includes("readdirSync") && code.includes("unlinkSync");
}

/** Arm B: files holding a createFilesystemCache CALL (the owner defines; it does not call). */
function cacheCallSites(files: readonly SourceRecord[]): string[] {
  const sites: string[] = [];
  for (const file of files) {
    if (file.path === CACHE_OWNER_PATH) continue;
    if (callArgumentsOf(file.source, "createFilesystemCache").length > 0) sites.push(rel(file.path));
  }
  return sites.sort();
}

/**
 * Arm C: cross-scope mutable counters in eviction-bearing modules. The
 * defect class is a counter that OUTLIVES one invocation — declared at
 * module level or in a factory closure, then mutated and threshold-compared
 * inside the functions that write — because such a counter is per-process
 * state standing in for a shared directory's contents (N processes × cap
 * before any process trims). A loop-local counter is declared and compared
 * in the SAME function scope and is harmless, so the discriminator is the
 * scope boundary itself: the declaration's enclosing function must differ
 * from the comparison's. The detector reads the CODE view (comments and
 * strings blanked), so prose cannot fire it.
 *
 * CONSERVATIVE BOUNDARY, stated: a same-invocation counter whose comparison
 * happens inside a synchronous nested callback (`entries.forEach(() => { if
 * (n >= cap) … })`) is flagged even though it re-initialises every call —
 * telling that arrow apart from a returned closure is the synchronous-
 * iterator problem, and the fix (hoist the comparison out of the callback)
 * is trivial. Zero live instances at introduction.
 */
function perProcessCounterViolations(files: readonly SourceRecord[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (!isEvictionBearing(file)) continue;
    const code = sourceViewOf(file.source, rel(file.path)).code();
    for (const decl of code.matchAll(/\b(?:let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\d/g)) {
      const name = decl[1]!;
      const mutated = new RegExp(`(?:\\b${name}\\s*(?:\\+\\+|--|\\+=|-=|\\*=|/=))|(?:\\+\\+|--)\\s*${name}\\b`).test(code);
      if (!mutated) continue;
      const declFn = enclosingFunctionOf(file.source, decl.index, "counter declaration");
      // The declaration's own scope span: module-level counters span the
      // whole file; a factory/closure counter spans its function body.
      const spanFrom = declFn === undefined ? 0 : declFn.offset;
      const spanTo = declFn === undefined ? file.source.length : declFn.offset + declFn.body.length;
      let crossScopeComparison = false;
      for (const cmp of code.matchAll(new RegExp(`\\b${name}\\s*(?:>=?|<=?|===?|!==?)`, "g"))) {
        const at = cmp.index ?? 0;
        // Only comparisons of THIS declaration — a same-named variable in a
        // sibling function is a different counter (the collision class).
        if (at < spanFrom || at > spanTo) continue;
        const cmpScope = enclosingFunctionOf(file.source, at, "counter comparison")?.offset ?? -1;
        // A comparison in a function NESTED INSIDE the declaration's scope
        // reads cross-invocation state (the nested function outlives one
        // invocation of the scope that resets the counter).
        if (cmpScope !== (declFn?.offset ?? -1)) {
          crossScopeComparison = true;
          break;
        }
      }
      if (!crossScopeComparison) continue;
      violations.push(
        `${rel(file.path)}: counter "${name}" is declared in one scope and threshold-compared in another — ` +
        "cross-invocation state in a module that lists and deletes files is a per-process trim counter, " +
        "which lets a shared cache grow to N processes × cap before any process trims; " +
        "route the trim through createSharedWriteCounter (or prune from a fresh directory listing)",
      );
    }
  }
  return violations;
}

/** Arm D: files (other than the owner) that name the counter file. */
function counterFileNameViolations(files: readonly SourceRecord[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (file.path === CACHE_OWNER_PATH) continue;
    const view = sourceViewOf(file.source, rel(file.path)).codeWithStringsAndTemplates();
    if (view.includes("write-counter")) {
      violations.push(
        `${rel(file.path)} names the shared counter file directly — the counter has ONE owner ` +
        "(scripts/verification/filesystem-cache.ts); a second module touching it is a second counter",
      );
    }
  }
  return violations;
}

test("filesystem cache discovery: the owner wires createSharedWriteCounter AND gates trims on it", () => {
  assert.deepEqual(ownerWiringViolations(readOwnerSource()), []);
});

test("filesystem cache discovery: the owner-wiring arm refuses BOTH the absent and the inert shape", () => {
  const ownerSource = readOwnerSource();
  // ABSENT: the counter is never created.
  const withoutCounter = mutateOwnerSource(
    ownerSource,
    "const counter = createSharedWriteCounter(cacheDirectory, config.maxEntries);",
    "",
  );
  assert.ok(
    ownerWiringViolations(withoutCounter).some((v) => v.includes("createSharedWriteCounter")),
    "removing the counter construction must be flagged",
  );
  // INERT: the counter is created but the trim is never gated on it (the
  // result is computed and discarded — the shape a duplication guard misses).
  const withoutGating = mutateOwnerSource(ownerSource, "if (counter.increment()) {", "if (true) {");
  assert.ok(
    ownerWiringViolations(withoutGating).some((v) => v.includes("counter.increment")),
    "discarding the counter's verdict must be flagged",
  );
  // LIVENESS: the unmodified owner produces no violations (the arm is not a
  // tautology that flags everything).
  assert.deepEqual(ownerWiringViolations(ownerSource), []);
});

test("filesystem cache discovery: every createFilesystemCache call site is found (liveness)", () => {
  const files = discoverEngineSources();
  assert.ok(files.length > 100, `the engine source universe should be large (got ${files.length} files)`);
  const sites = cacheCallSites(files);
  console.log(`[filesystem cache discovery] ${sites.length} createFilesystemCache call sites: ${sites.join(", ")}`);
  // Liveness: the known population is several caches; an empty answer means
  // the discovery broke, not that the tree is clean.
  assert.ok(sites.length > 0, "no createFilesystemCache call sites found — the discovery is broken");
});

test("filesystem cache discovery: no inline cache gates its trim on a per-process counter", () => {
  const files = discoverEngineSources();
  const evictionBearing = files.filter((file) => isEvictionBearing(file));
  console.log(
    `[filesystem cache discovery] ${evictionBearing.length} eviction-bearing modules: ${evictionBearing.map((file) => rel(file.path)).join(", ")}`,
  );
  assert.ok(
    evictionBearing.length > 0,
    "no eviction-bearing modules found — the universe is empty, so the guard would pass having examined nothing",
  );
  assert.deepEqual(perProcessCounterViolations(files), []);
});

test("filesystem cache discovery: the per-process-counter arm refuses a planted inline cache", () => {
  const files = discoverEngineSources();
  const plant: SourceRecord = {
    path: join(REPO_ROOT, "scripts", "planted-inline-cache.ts"),
    source: [
      'import { readdirSync, unlinkSync } from "node:fs";',
      "let sweepCount = 0;",
      "export function prunePlantedCache(dir: string, cap: number): void {",
      "  sweepCount += 1;",
      "  if (sweepCount >= cap) {",
      "    for (const name of readdirSync(dir)) unlinkSync(`${dir}/${name}`);",
      "    sweepCount = 0;",
      "  }",
      "}",
    ].join("\n"),
  };
  const violations = perProcessCounterViolations([...files, plant]);
  assert.ok(
    violations.some((v) => v.includes("planted-inline-cache.ts") && v.includes("sweepCount")),
    `a planted per-process trim counter must be flagged (got: ${violations.join("; ") || "nothing"})`,
  );
  // The CLOSURE shape (the original defect): the counter is declared inside
  // a factory function and compared inside the writer it returns — still
  // cross-scope state, still per-process.
  const closurePlant: SourceRecord = {
    path: join(REPO_ROOT, "scripts", "planted-closure-cache.ts"),
    source: [
      'import { readdirSync, unlinkSync } from "node:fs";',
      "export function createPlantedCache(dir: string, cap: number) {",
      "  let writesSinceSweep = 0;",
      "  return {",
      "    write(name: string): void {",
      "      writesSinceSweep += 1;",
      "      if (writesSinceSweep >= cap) {",
      "        for (const entry of readdirSync(dir)) unlinkSync(`${dir}/${entry}`);",
      "        writesSinceSweep = 0;",
      "      }",
      "    },",
      "  };",
      "}",
    ].join("\n"),
  };
  assert.ok(
    perProcessCounterViolations([...files, closurePlant]).some((v) => v.includes("writesSinceSweep")),
    "a closure-scoped per-process counter (the original defect shape) must be flagged",
  );
  // The INERT twin: the same eviction module with no mutable counter (a
  // fresh-listing prune like compile-cache.ts) must NOT be flagged.
  const cleanTwin: SourceRecord = {
    path: join(REPO_ROOT, "scripts", "planted-inline-cache.ts"),
    source: [
      'import { readdirSync, statSync, unlinkSync } from "node:fs";',
      "export function prunePlantedCache(dir: string, cap: number): void {",
      "  const entries = readdirSync(dir);",
      "  if (entries.length <= cap) return;",
      "  for (const name of entries.slice(0, entries.length - cap)) {",
      "    if (statSync(`${dir}/${name}`).isFile()) unlinkSync(`${dir}/${name}`);",
      "  }",
      "}",
    ].join("\n"),
  };
  assert.deepEqual(
    perProcessCounterViolations([...files, cleanTwin]).filter((v) => v.includes("planted-inline-cache.ts")),
    [],
    "a fresh-listing prune with no in-memory counter must NOT be flagged",
  );
  // The LOOP-LOCAL twin: a counter declared, mutated and compared in one
  // function scope (a throttle, a loop index) is not cross-invocation state
  // and must NOT be flagged — this is the false-positive boundary.
  const loopLocalTwin: SourceRecord = {
    path: join(REPO_ROOT, "scripts", "planted-loop-cache.ts"),
    source: [
      'import { readdirSync, unlinkSync } from "node:fs";',
      "export function prunePlantedCache(dir: string, cap: number): void {",
      "  let checked = 0;",
      "  for (const entry of readdirSync(dir)) {",
      "    checked += 1;",
      "    if (checked >= cap) { unlinkSync(`${dir}/${entry}`); checked = 0; }",
      "  }",
      "}",
    ].join("\n"),
  };
  assert.deepEqual(
    perProcessCounterViolations([...files, loopLocalTwin]).filter((v) => v.includes("planted-loop-cache.ts")),
    [],
    "a loop-local counter (declared + compared in one scope) must NOT be flagged",
  );
});

test("filesystem cache discovery: the counter file name has exactly one owner", () => {
  const files = discoverEngineSources();
  // Liveness: the owner itself must name the counter file, or the scan is
  // looking for the wrong string. The subject lives inside a quoted string,
  // so it is asked of the strings-preserving view.
  assert.ok(
    readSourceView(CACHE_OWNER_PATH).codeWithStringsAndTemplates().includes("write-counter"),
    "the owner no longer names the counter file — the ownership scan would be vacuous",
  );
  assert.deepEqual(counterFileNameViolations(files), []);
  // A planted second namer is refused.
  const plant: SourceRecord = {
    path: join(REPO_ROOT, "src", "planted-counter-reader.ts"),
    source: 'export const counterFile = ".write-counter" as const;',
  };
  assert.ok(
    counterFileNameViolations([...files, plant]).some((v) => v.includes("planted-counter-reader.ts")),
    "a second module naming the counter file must be flagged",
  );
});

/** Arm E: analysis-cache call sites whose key carries no analyzer salt and no documented exemption. */
function unsaltedAnalysisCacheKeyViolations(files: readonly SourceRecord[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (file.path === CACHE_OWNER_PATH) continue;
    if (callArgumentsOf(file.source, "createFilesystemCache").length === 0) continue;
    // A real call node, not a mention: the salt is a call expression inside
    // the key construction, so a string or comment naming the helper can
    // never satisfy the census.
    if (callArgumentsOf(file.source, "analysisSemanticsId").length > 0) continue;
    // The exemption marker is a comment, so it is asked of the prose view —
    // and it must carry a reason (text after the marker), not just the tag.
    const exempt = sourceViewOf(file.source, rel(file.path)).prose()
      .some((line) => /@unsalted-cache-key\s+\S/.test(line.text));
    if (exempt) continue;
    violations.push(
      `${rel(file.path)} builds a filesystem cache whose key does not carry the analyzer's own bytes (no analysisSemanticsId call in the key construction, no @unsalted-cache-key reason) — ` +
        "a cache keyed by content alone serves entries written before the analyzer's behavior changed, masking the change; " +
        "salt the key with analysisSemanticsId(import.meta.url, …) or document why this cache is exempt",
    );
  }
  return violations;
}

test("filesystem cache discovery: every analysis cache key carries the analyzer's own bytes or a documented exemption", () => {
  const files = discoverEngineSources();
  // Liveness: the population must include the salted members, or the census
  // is green because it examined nothing.
  const sites = cacheCallSites(files);
  const saltedSites = sites.filter((site) => {
    const file = files.find((candidate) => rel(candidate.path) === site)!;
    return callArgumentsOf(file.source, "analysisSemanticsId").length > 0;
  });
  assert.ok(
    saltedSites.length >= 4,
    `at least the shape + architecture + governed-source + static-literal analysis caches must be salted members (salted: ${saltedSites.join(", ")}; all sites: ${sites.join(", ")})`,
  );
  assert.deepEqual(unsaltedAnalysisCacheKeyViolations(files), []);
});

test("filesystem cache discovery: the key-salt census refuses unsalted plants and accepts both honest exits", () => {
  const files = discoverEngineSources();
  // A new analysis cache with no salt and no reason is refused.
  const unsaltedPlant: SourceRecord = {
    path: join(REPO_ROOT, "scripts", "planted-unsalted-cache.ts"),
    source: [
      'import { readFileSync } from "node:fs";',
      'import { createFilesystemCache } from "./verification/filesystem-cache.ts";',
      "const plantedCache = createFilesystemCache({ directory: 'harness-planted-cache', maxEntries: 8 });",
      "export function analyzePlanted(path: string): unknown {",
      "  const contentHash = sha256(readFileSync(path, 'utf8'));",
      "  return plantedCache.read(`${path}\\u0000${contentHash}`, (v) => v);",
      "}",
    ].join("\n"),
  };
  assert.ok(
    unsaltedAnalysisCacheKeyViolations([...files, unsaltedPlant]).some((v) => v.includes("planted-unsalted-cache.ts")),
    "an unsalted analysis cache with no exemption must be flagged",
  );
  // The documented-exemption exit stays green (the pending-sibling shape).
  const exemptPlant: SourceRecord = {
    ...unsaltedPlant,
    source: `// @unsalted-cache-key deferred to its own change\n${unsaltedPlant.source}`,
  };
  assert.deepEqual(
    unsaltedAnalysisCacheKeyViolations([...files, exemptPlant]).filter((v) => v.includes("planted-unsalted-cache.ts")),
    [],
    "a cache with a documented @unsalted-cache-key reason must NOT be flagged",
  );
  // The salted exit stays green.
  const saltedPlant: SourceRecord = {
    ...unsaltedPlant,
    source: [
      'import { readFileSync } from "node:fs";',
      'import { analysisSemanticsId, createFilesystemCache } from "./verification/filesystem-cache.ts";',
      "const plantedCache = createFilesystemCache({ directory: 'harness-planted-cache', maxEntries: 8 });",
      "export function analyzePlanted(path: string): unknown {",
      "  const contentHash = sha256(readFileSync(path, 'utf8'));",
      "  return plantedCache.read(`${path}\\u0000${contentHash}\\u0000${analysisSemanticsId(import.meta.url)}`, (v) => v);",
      "}",
    ].join("\n"),
  };
  assert.deepEqual(
    unsaltedAnalysisCacheKeyViolations([...files, saltedPlant]).filter((v) => v.includes("planted-unsalted-cache.ts")),
    [],
    "a cache whose key construction calls analysisSemanticsId must NOT be flagged",
  );
});

test("architecture analysis cache ignores entries keyed before the analyzer's current bytes", () => {
  // A cached analysis is a function of the source AND the analyzer: an
  // entry written under a key with no analyzer salt (the format the cache
  // used before salting, and the shape a differently-behaved analyzer once
  // wrote a poisoned entry under) must never be served. Plant exactly such
  // an entry — a fabricated stale facts object under the path +
  // content-only key — and require the analysis to compute fresh. The
  // planted key is unreachable by any product path after the salt, exactly
  // the tripwire that reds if anyone severs it.
  const probePath = "verification/arch-cache-probe.ts";
  const fixture = [
    'import { join } from "node:path";',
    "export const freshProbe = 1;",
    "export function freshProbeCount(value: string): number { return join(value).length; }",
  ].join("\n");
  const contentHash = sha256(Buffer.from(fixture, "utf8"));
  const cache = createFilesystemCache({
    directory: "harness-arch-cache",
    maxEntries: DEFAULT_ARCHITECTURE_SOURCE_FILESYSTEM_CACHE_MAX_ENTRIES,
  });
  cache.write(`${probePath}\u0000${contentHash}`, {
    dependencies: [],
    typeOnlyDependencies: [],
    importedSymbols: [],
    exportedNames: ["staleAnalyzerResult"],
    declaredNames: [],
    constructedTypes: [],
    directEffectFacts: [],
    unmodeledEffects: [],
    directExecutionEntrypoint: false,
    topLevelExecution: false,
    nodeCount: 1,
  });
  const facts = analyzeArchitectureSource(probePath, fixture);
  assert.deepEqual([...facts.exportedNames], ["freshProbe", "freshProbeCount"],
    "a cache entry keyed by path + content alone must not be served for the current analyzer bytes");
});

test("governed-source violations cache ignores entries keyed before the analyzer's current bytes", () => {
  // The violations analysis caches by (path, content, enforcement mode,
  // allowed effects) AND the analyzer's bytes. An entry written under the
  // pre-salt key — the format the cache used before the analyzer's own
  // bytes joined the key — must never be served: plant a fabricated
  // violations array under exactly that key and require the verification
  // to compute fresh. The planted key is unreachable by any product path
  // after the salt, exactly the tripwire that reds if anyone severs it.
  clearGovernedSourceParseCache();
  const probePath = "scripts/tooling/governed-cache-probe.ts";
  const fixture = 'const probeValue = process.env.HOME;\n';
  const contentHash = sha256(Buffer.from(fixture, "utf8"));
  const effectsHash = canonicalHash([] as readonly string[]);
  const cache = createFilesystemCache({
    directory: "harness-governed-cache",
    maxEntries: DEFAULT_GOVERNED_SOURCE_VIOLATIONS_FILESYSTEM_CACHE_MAX_ENTRIES,
  });
  cache.write(`${probePath}\u0000${contentHash}\u0000true\u0000${effectsHash}`, ["staleAnalyzerResult"]);
  const violations: string[] = [];
  verifyGovernedTypeScriptSource(probePath, fixture, violations, true, new Set());
  assert.ok(
    violations.includes(`environment-configuration-source:${probePath}`),
    "the fresh analysis must run: the probe fixture's real violation is present",
  );
  assert.ok(
    !violations.includes("staleAnalyzerResult"),
    "a cache entry keyed without the analyzer's bytes must not be served for the current analyzer bytes",
  );
});




test("architecture analysis cache rejects malformed erased-reference entries", () => {
  const cache = createFilesystemCache({ directory: "harness-arch-cache", maxEntries: DEFAULT_ARCHITECTURE_SOURCE_FILESYSTEM_CACHE_MAX_ENTRIES });
  const semantics = analysisSemanticsId(new URL("../../scripts/verification/architecture.ts", import.meta.url), new URL("../../scripts/verification/effect-surface.ts", import.meta.url));
  for (const [index, malformed] of [[1], [null], ["src/types.ts", {}]].entries()) {
    const path = `src/erased-cache-${index}.ts`;
    const source = 'import type { T } from "./types.ts";';
    const facts = analyzeArchitectureSource(path, source);
    const key = `${path}\0${sha256(Buffer.from(source, "utf8"))}\0${semantics}`;
    try {
      cache.write(key, { ...facts, typeOnlyDependencies: malformed });
      clearArchitectureSourceCache();
      assert.deepEqual(analyzeArchitectureSource(path, source).typeOnlyDependencies, ["src/types.ts"]);
    } finally { cache.write(key, facts); clearArchitectureSourceCache(); }
  }
});

test("analysis identity frames source texts with embedded NUL without aliasing native behavior", async () => {
  const dir = createTempDir("cache-source-tuples-");
  const first = 'import { x } from "./helper.mjs"; export const analyze = () => x; //A';
  const pairs = [
    [first, 'export const x=1;//B\0export const x=2;'],
    [first + '\0export const x=1;//B', 'export const x=2;'],
  ];
  assert.equal(pairs[0]!.join("\0"), pairs[1]!.join("\0"), "the former framing really collides");
  const ids: (string | undefined)[] = [];
  const observed: number[] = [];
  for (const [index, pair] of pairs.entries()) {
    const home = join(dir, String(index));
    mkdirSync(home);
    writeFileSync(join(home, "analyzer.mjs"), pair[0]!);
    writeFileSync(join(home, "helper.mjs"), pair[1]!);
    const analyzer = pathToFileURL(join(home, "analyzer.mjs"));
    ids.push(analysisSemanticsId(analyzer, pathToFileURL(join(home, "helper.mjs"))));
    observed.push((await import(analyzer.href)).analyze());
    assert.equal(analysisSemanticsId(analyzer, pathToFileURL(join(home, "helper.mjs"))), ids[index], "warm identity stays stable");
  }
  assert.deepEqual(observed, [1, 2]);
  assert.notEqual(ids[0], ids[1], "distinct native behavior must not share a semantic identity");
  assert.deepEqual(ids, pairs.map((pair) => sha256(canonicalJson(pair))), "ordered source text tuple owns the semantic salt");
});

test("analysis identity frames raw URL memo tuples independently of ignored fragments", () => {
  const dir = createTempDir("cache-url-tuples-");
  const texts = ["export const x=0;", "export const x=1;", "export const x=2;"];
  const urls = texts.map((source, index) => {
    const path = join(dir, `${index}.mjs`);
    writeFileSync(path, source);
    return pathToFileURL(path).href;
  });
  for (const reverse of [false, true]) {
    const a = urls[0]! + "#x" + reverse, b = urls[1]! + "#y" + reverse, c = urls[2]!;
    const pairs = [[a, b + "\0" + c], [a + "\0" + b, c]];
    assert.equal(pairs[0]!.join("\0"), pairs[1]!.join("\0"));
    assert.deepEqual(pairs.map((pair) => pair.map((url) => readFileSync(fileURLToPath(url), "utf8"))),
      [[texts[0], texts[1]], [texts[0], texts[2]]]);
    if (reverse) pairs.reverse();
    const ids = pairs.map((pair) => analysisSemanticsId(pair[0]!, pair[1]!));
    assert.notEqual(ids[0], ids[1], "different URL tuples must not reuse a memoized salt");
    assert.deepEqual(ids, pairs.map((pair) => sha256(canonicalJson(pair.map((url) => readFileSync(fileURLToPath(url), "utf8"))))));
  }
});

test("analysis identity does not memoize source unavailability and recovers when files appear", () => {
  const dir = createTempDir("cache-identity-recovery-");
  const owner = pathToFileURL(join(dir, "owner.mjs"));
  const helper = pathToFileURL(join(dir, "helper.mjs"));
  assert.equal(analysisSemanticsId(owner, helper), undefined);
  writeFileSync(owner, "export const owner = 1;");
  assert.equal(analysisSemanticsId(owner, helper), undefined);
  writeFileSync(helper, "export const helper = 2;");
  const id = analysisSemanticsId(owner, helper);
  assert.equal(id, sha256(canonicalJson([readFileSync(owner, "utf8"), readFileSync(helper, "utf8")])));
  rmSync(owner); rmSync(helper);
  assert.equal(analysisSemanticsId(owner, helper), id, "successful identity remains process-memoized");
});

// Each child starts before a successful identity can be memoized. Only the
// selected real source read fails; native cache reads remain accessible.
const RESULT_CACHE_AVAILABILITY_PROBE = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
const [owner, failure, root] = process.argv.slice(1);
const definitions = {
  architecture: ['scripts/verification/architecture.ts', 'scripts/verification/effect-surface.ts', 'harness-arch-cache'],
  static: ['scripts/verification/static-source.ts', 'src/shared/source-extensions.ts', 'harness-static-cache'],
  governed: ['scripts/tooling/verification/governed-source.ts', 'scripts/verification/effect-surface.ts', 'harness-governed-cache'],
  literal: ['scripts/tooling/s1-verification.ts', 'src/kernel/product-identity.ts', 'harness-static-literal-cache'],
};
const [relativeOwner, relativeDependency, directory] = definitions[owner];
const mod = await import(pathToFileURL(path.join(root, relativeOwner)).href);
const {analysisSemanticsId, createFilesystemCache} = await import(pathToFileURL(path.join(root, 'scripts/verification/filesystem-cache.ts')).href);
const {canonicalHash, sha256} = await import(pathToFileURL(path.join(root, 'src/kernel/integrity.ts')).href);
const {ROOT_POLICY} = await import(pathToFileURL(path.join(root, 'src/kernel/root-policy.ts')).href);
const {resetDebugSystem, getDebugSignals} = await import(pathToFileURL(path.join(root, 'src/shared/debug/debug-system.ts')).href);
const cacheDir = path.join(process.env.TMPDIR, directory);
const sourcePath = 'src/cache-availability.ts';
const source = owner === 'governed' ? 'const value = process.env.HOME; eval("x");' : 'export const VALUE = { selected: 1 };';
const native = {readFileSync:fs.readFileSync, existsSync:fs.existsSync};
const denied = path.join(root, failure === 'own' ? relativeOwner : relativeDependency);
let deny = true, attempts = 0, resultReads = 0, slices = 0;
const signatures = [];
const clear = () => { mod.clearArchitectureSourceCache?.(); mod.clearStaticModuleShapeCache?.(); mod.clearGovernedSourceParseCache?.(); mod.clearVerifyS1StructureCache?.(); };
function call(text = source) {
  if (owner === 'architecture') return mod.analyzeArchitectureSource(sourcePath, text);
  if (owner === 'static') return mod.analyzeStaticModuleShape(text, sourcePath);
  if (owner === 'literal') return mod.extractBoundedTopLevelStaticLiteral(text, 'VALUE', ['selected']);
  const violations = [], pushes = [];
  violations.push = function(...items) { pushes.push([...items]); return Array.prototype.push.apply(this, items); };
  violations.slice = function(...args) { slices++; return Array.prototype.slice.apply(this, args); };
  mod.verifyGovernedTypeScriptSource(sourcePath, text, violations, true, new Set());
  signatures.push(pushes);
  return [...violations];
}
const disk = () => fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).sort().map(name=>[name,native.readFileSync(path.join(cacheDir,name)).toString('hex')]) : [];
const cache = createFilesystemCache({directory, maxEntries:1000});
const contentHash = sha256(Buffer.from(source,'utf8'));
const fallback = 'analyzer-source-unavailable';
const fallbackKey = owner === 'governed' ? [sourcePath, contentHash, 'true', canonicalHash([]), fallback].join('\0') :
  owner === 'literal' ? [contentHash, 'VALUE', 'selected', 'none', canonicalHash({}), fallback].join('\0') : [sourcePath, contentHash, fallback].join('\0');
try {
  fs.readFileSync = function(file,...args) { if (String(file) === denied && deny) { attempts++; throw Error('private-source-failure'); } if(String(file).startsWith(cacheDir+path.sep) && String(file).endsWith('.json')) resultReads++; return native.readFileSync.call(this,file,...args); };
  fs.existsSync = function(file) { if(String(file).startsWith(cacheDir+path.sep) && String(file).endsWith('.json')) resultReads++; return native.existsSync.call(this,file); };
  syncBuiltinESMExports();
  resetDebugSystem();
  const before = disk();
  const first = call();
  const second = call();
  assert.equal(resultReads, 0, 'unavailable identity must bypass result reads');
  assert.deepEqual(disk(), before, 'unavailable identity must not write result entries or counters');
  assert.equal(attempts, 2, 'failed identity must be retried, never memoized');
  assert.equal(getDebugSignals().bestEffortFailures, 2, 'each source refusal reports through the central fixed diagnostic');
  if(owner === 'architecture' || owner === 'static') assert.notStrictEqual(first,second,'unavailable results must not be memory cached');
  if(owner === 'governed') { assert.equal(slices,0,'unavailable results must not be sliced into memory cache'); assert.deepEqual(signatures[0],signatures[1]); assert.ok(signatures[0].length>1,'multiple real violation pushes distinguish a cached spread'); }
  const poison = owner === 'governed' ? ['stale-unavailable-result'] : owner === 'literal' ? {ok:true,value:999} : {...first, exportedNames:['stale-unavailable-result']};
  cache.write(fallbackKey,poison);
  assert.deepEqual(cache.read(fallbackKey,v=>v),poison,'planted fallback entry is really readable');
  const planted = disk(); resultReads = 0; slices = 0;
  assert.deepEqual(call(),first,'readable stale fallback cannot become analysis authority');
  assert.equal(resultReads,0);
  assert.equal(slices,0);
  assert.deepEqual(disk(),planted);
  if(owner === 'governed') {
    assert.ok(call('const = ;').includes('governed-static-analysis-parse:'+sourcePath));
    const many = 'void 0;'.repeat(Math.ceil(ROOT_POLICY.forensics.limits.maximumNodes/3)+1);
    assert.ok(Buffer.byteLength(many)<ROOT_POLICY.forensics.limits.maximumInputBytes,'node budget witness reaches AST walk');
    // The existing parse owner rejects over-budget ASTs before the public
    // walk, so the actual current diagnostic is the parse refusal.
    assert.deepEqual(call(many),['governed-static-analysis-parse:'+sourcePath]);
    assert.equal(slices,0); assert.equal(resultReads,0); assert.deepEqual(disk(),planted,'early exits cannot cache without identity');
  }
  deny = false; resultReads = 0;
  const recovered = call();
  assert.deepEqual(recovered, first);
  assert.ok(resultReads>0,'recovery resumes filesystem lookup');
  const entries = fs.readdirSync(cacheDir).filter(n=>n.endsWith('.json')).map(n=>[n,JSON.parse(native.readFileSync(path.join(cacheDir,n),'utf8'))]);
  const actual = entries.find(([,entry])=>entry.cacheKey!==fallbackKey);
  assert.ok(actual,'recovery writes a real identity entry');
  const counter = native.readFileSync(path.join(cacheDir,'.write-counter'));
  cache.write(actual[1].cacheKey,poison);
  resultReads = 0;
  const warm = call();
  if(owner === 'literal') { assert.deepEqual(warm,poison); assert.ok(resultReads>0,'literal result cache is filesystem only'); }
  else { assert.deepEqual(warm,first); assert.equal(resultReads,0,'available in-memory hit remains live'); }
  clear(); resultReads = 0;
  assert.deepEqual(call(),poison,'available cold-memory filesystem hit remains live');
  assert.ok(resultReads>0);
  const postWarmCounter = native.readFileSync(path.join(cacheDir,'.write-counter'));
  assert.equal(postWarmCounter.length,counter.length+1,'only the deliberate poison write changes warm counter');
  console.log(JSON.stringify({owner,failure,attempts,sourceUnavailable:true,recovered:true,memoryResultCache:owner!=='literal',diskWarm:true,earlyReturns:owner==='governed'}));
} finally { fs.readFileSync=native.readFileSync;fs.existsSync=native.existsSync;syncBuiltinESMExports(); }
`;

for (const owner of ["architecture", "static", "governed", "literal"]) {
  for (const failure of ["own", "dependency"]) {
    test(`result cache availability: ${owner} ${failure} failure bypasses caches and recovers`, () => {
      const dir = createTempDir(`cache-availability-${owner}-${failure}-`);
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", RESULT_CACHE_AVAILABILITY_PROBE,
        owner, failure, fileURLToPath(new URL("../../", import.meta.url))], {
        env: { ...process.env, TMPDIR: dir }, encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout.trim()).recovered, true);
      assert.ok(!result.stderr.includes("private-source-failure"), "central bestEffort diagnostic must not expose caught text");
    });
  }
}
