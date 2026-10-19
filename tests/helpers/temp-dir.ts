/**
 * SINGLE-PARTY OWNER of test temporary directories.
 *
 * ── The defect this exists to make impossible ────────────────────────────
 *
 * Test files created temp dirs with `mkdtempSync(join(tmpdir(), prefix))` and
 * removed them with a hand-written hook. The two halves drifted apart, and the
 * dominant failure shape was a SCOPE MISMATCH:
 *
 *     beforeEach(() => { tmpRoot = mkdtempSync(join(tmpdir(), "ch-web-db-")); });
 *     afterAll(()  => { rmSync(tmpRoot, { recursive: true, force: true }); });
 *
 * `beforeEach` creates one directory PER TEST; `afterAll` removes only the
 * LAST one. A file with N tests leaks N-1 directories per run. Measured in
 * /tmp before this owner existed: 25,112 × `ch-web-db-*`, 6,600 × `ch-history-*`,
 * 74,476 stale entries in total — the 36G tmpfs reached 100% and test runs
 * began failing with ENOSPC.
 *
 * The weak fix is "remember to write the matching hook". The evidence is that
 * people don't. So creation and removal are fused into ONE call here: there is
 * no exported way to create a temp dir without its removal already registered.
 *
 * ── Why these mechanisms (built-ins, not custom machinery) ───────────────
 *
 * Vitest 4 supplies everything needed; nothing here is a bespoke scheduler.
 *
 * 1. `onTestFinished` — the per-test hook. Verified in this Vitest version
 *    (4.1.10) to be callable BOTH from inside a test body and from inside
 *    `beforeEach` (which runs in test context), and — the case that actually
 *    caused the leak — to run even when the test THROWS. This is what makes
 *    the `beforeEach` shape above correct by construction: the dir is removed
 *    when *that* test ends, not when the file ends.
 *
 * 2. A per-file sweep drained from the existing setup file. `onTestFinished`
 *    throws when there is no test context, i.e. at module scope and inside
 *    `beforeAll`. The obvious fallback — calling `afterAll()` from the helper
 *    — was probed and DOES NOT WORK when the call originates inside a
 *    `beforeAll` hook: by then Vitest has already collected the file's hooks,
 *    the registration is silently dropped, and the directory leaks. (Probed
 *    directly; a `beforeAll`-created dir survived the run.) So dirs created
 *    outside test context are tracked in `LIVE` and removed by
 *    `sweepTempDirs()`, which `tests/setup/test-setup.ts` calls from
 *    an `afterAll` — setup-file hooks are registered per test FILE, which is
 *    exactly the scope those directories belong to.
 *
 * `LIVE` is a bookkeeping set, not a scheduler: it holds only dirs that are
 * still on disk, and every entry has a registered remover (per-test hook or
 * the per-file sweep). Under `isolate: true` each file gets its own module
 * registry — so `LIVE` holds exactly the dirs the file created — and files
 * run sequentially within a worker, so the per-file sweep draining every
 * live dir is correct: nothing outlives the file that created it.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";

import { admitKeyHome, type AdmittedKeyHome } from "../../engine/src/filesystem/self-protection/key-home.ts";
import { ROOT_POLICY } from "../../engine/src/kernel/root-policy.ts";

/** Temp dirs created but not yet removed. Drained by `sweepTempDirs()`. */
const LIVE = new Set<string>();

/**
 * Worker-scoped dirs, keyed by prefix — created once per WORKER, not per file,
 * so the per-file sweep must not touch them. A dir that backs the worker's
 * data stores has to outlive every file in the worker: removing it after file
 * 1 would leave files 2..N writing into a path that no longer exists, and the
 * SQLite handle memoised inside `server/timeline-bridge.ts` pointing at a
 * deleted file.
 *
 * This module is NOT a setup file, so under `isolate: false` it is evaluated
 * once per worker and this map is genuinely worker-scoped — whereas vitest
 * re-executes setup files for every test file, which is why memoising here
 * rather than there is what makes "once per worker" true. (Measured: without
 * the memo, a 369-file run left 369 store dirs behind per worker pass.)
 */
const WORKER_DIRS = new Map<string, string>();

/**
 * How long a worker store may sit in the temp root before a later run reclaims
 * it. A full suite run takes ~27s, so 30 minutes is orders of magnitude past
 * any live store while still bounding the residue tightly.
 *
 * Measured residue with this reclaim in place: a five-run pass left 381 dirs
 * totalling 14 MB, of which only 81 held a database at all — vitest spawns far
 * more workers per run than there are cores. Before the per-worker memo it was
 * one directory PER TEST FILE (369 per run). The standing cost is therefore
 * "half an hour of runs", not unbounded growth.
 *
 * ── THE MEMO DOES NOT HOLD UNDER `isolate: true`, AND THAT IS MEASURED ──
 *
 * `WORKER_DIRS` memoises per MODULE REGISTRY. `vitest.config.ts` set
 * `isolate: true` (because `vi.mock` was being silently ignored under a
 * shared registry), and an isolated file gets a FRESH registry — so the memo
 * is empty on every file and this reclaim runs once per test FILE, not once
 * per worker. Counted directly in `/tmp`: **exactly 416 stores per run
 * against 416 test files.**
 *
 * That is a fact about vitest's isolation, not a defect to fix here — a
 * shared store across files would put file 2's ledger rows in file 1's
 * database. What it makes unaffordable is a reclaim that COSTS anything, and
 * the old one cost a `readdirSync` of the whole temp root plus a `statSync`
 * per matching entry. Measured at a realistic residue of 6,238 stores in a
 * 10,241-entry `/tmp`: **30.5ms per call × 416 files = 12.7s of pure syscall
 * per run**, and it grew as residue grew — the exact "statSync storm" named
 * in DESIGN-PERFORMANCE §1 L1. The suite's `setup` phase fell **33.4s →
 * 17.8s** when the residue was cleared by hand, which is how the cost was
 * confirmed rather than inferred.
 *
 * Both halves of that cost are now gone by construction, not by tuning:
 *   - the stores live in their OWN directory, so the scan never walks the
 *     thousands of unrelated entries in the temp root;
 *   - the store's own NAME carries its creation time, so staleness is a
 *     string comparison and there is no `statSync` at all.
 */
const WORKER_DIR_STALE_MS = 30 * 60 * 1000;

/**
 * The directory that holds every worker store — a room of our own inside the
 * temp root, divided into TIME BUCKETS.
 *
 * ── WHY BUCKETS, AND NOT JUST OUR OWN FLAT DIRECTORY ────────────────────
 *
 * A flat directory was the first fix and it was not enough. Scoping the scan
 * to our own dirs took the reclaim from 30.5ms to 5.2ms per call — but the
 * cost was still proportional to the RESIDUE, and the residue grows during a
 * burst of runs precisely when it hurts.
 *
 * Measured, which is the only reason this second pass exists: after six
 * back-to-back runs the root held **5,064 stores of which ZERO were stale**,
 * because the 30-minute reclaim window is longer than a burst. At ~29s per
 * run that steady state is ~26,000 stores, and a `readdir` of 26,000 entries
 * done once per test FILE is ~11s per run — the original storm, back, with a
 * smaller constant and the same shape. A fix whose cost still scales with the
 * thing it is supposed to bound has not fixed it.
 *
 * Bucketing removes the scaling instead of shrinking it. A store goes into a
 * directory named for the 5-minute window it was created in, so:
 *   - the reclaim reads the ROOT, which holds one entry per window — about
 *     seven of them, forever, no matter how many stores exist;
 *   - a whole expired window is removed with ONE `rmSync`, rather than by
 *     naming its members.
 *
 * The per-file cost is now constant. That is the property; 5.2ms → ~0.05ms is
 * only the number it currently takes.
 */
const WORKER_ROOT = join(tmpdir(), "ch-web-worker-stores");

/** Width of one bucket. Small enough that expiry is prompt, large enough that
 *  the root never holds more than a handful of entries. */
const BUCKET_MS = 5 * 60 * 1000;

/** Bucket directory names are `b<base36 index>` — the index is the only
 *  thing the reclaim needs, and it is in the name. */
const BUCKET_PREFIX = "b";

/** The bucket a moment belongs to. */
export function bucketNameFor(atMs: number): string {
  return `${BUCKET_PREFIX}${Math.floor(atMs / BUCKET_MS).toString(36)}`;
}

/**
 * The LAST instant a store in this bucket could have been created, or `null`
 * when the name is not one of ours.
 *
 * The latest possible member is what staleness must be judged on: judging by
 * the bucket's START would expire a window while a store created at its end
 * is still `BUCKET_MS` younger than the caller thinks. `null` is never
 * treated as stale, so an unrecognised directory is not deleted on a guess.
 */
export function bucketEndMs(name: string): number | null {
  if (!name.startsWith(BUCKET_PREFIX)) return null;
  const idx = Number.parseInt(name.slice(BUCKET_PREFIX.length), 36);
  if (!Number.isFinite(idx) || idx <= 0) return null;
  return (idx + 1) * BUCKET_MS;
}

function remove(dir: string): void {
  LIVE.delete(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Cleanup is best-effort: a failure to unlink must never turn a passing
    // test red, and the sweep will not see this dir again either way.
  }
}

/**
 * Create a temporary directory that CANNOT outlive its test.
 *
 * Removal is registered in this same call, so the two cannot be separated:
 * - called from a test body or `beforeEach` → removed via `onTestFinished`,
 *   including when the test fails or throws;
 * - called at module scope or in `beforeAll` → removed by the per-file sweep.
 *
 * @param prefix directory-name prefix, e.g. `"ch-web-db-"`. A trailing `-` is
 *        added when absent so generated names stay readable.
 */
export function createTempDir(
  prefix: string,
  options: Readonly<{
    /**
     * Create the directory beside THIS path instead of under the system temp
     * root, and register its removal exactly the same way.
     *
     * ── WHY THIS DOOR EXISTS, MEASURED ─────────────────────────────────────
     *
     * A HARD LINK CANNOT CROSS A FILESYSTEM. `/tmp` is a different device from
     * the workspace here (`EXDEV: cross-device link not permitted`), so a test
     * that plants a second name for a repository file — which is how the
     * protected-set link-count check is proven — cannot use a system temp
     * directory at all. Without this option such a test has to call `mkdtemp`
     * itself, which is exactly the scattered ownership this module exists to
     * end, and the guard that enforces it would then need an exemption.
     *
     * Widening the owner is the answer rather than exempting a caller: the
     * directory is still tracked, still swept when the test finishes, and
     * still swept if the test dies part-way.
     */
    besidePath?: string;
  }> = {},
): string {
  if (prefix.length === 0 || prefix.includes("/") || prefix.includes("\\")) {
    throw new Error(`createTempDir: invalid prefix ${JSON.stringify(prefix)}`);
  }
  const root = options.besidePath === undefined ? tmpdir() : dirname(options.besidePath);
  const dir = mkdtempSync(join(root, prefix.endsWith("-") ? prefix : `${prefix}-`));
  LIVE.add(dir);
  try {
    onTestFinished(() => {
      remove(dir);
    });
  } catch {
    // No test context (module scope / `beforeAll`). The dir stays in LIVE and
    // the per-file sweep in tests/setup/test-setup.ts removes it.
    // Registering `afterAll` here instead would be silently dropped when the
    // caller is inside `beforeAll` — see the header note.
  }
  return dir;
}

/**
 * Create a temporary directory scoped to the WORKER, not to a test or a file.
 *
 * ── Why this door exists ─────────────────────────────────────────────────
 *
 * Some state is resolved ONCE per worker and cannot be re-pointed per file:
 * `server/timeline-bridge.ts` memoises its SQLite handle in a module-scope
 * `let` on first use, and computes its ledger-id sidecar path at module
 * evaluation. Under `isolate: false` the module registry is shared, so
 * whichever file opens the ledger first binds the path for the whole worker.
 *
 * That is why the ledger leak was invisible per file: no single test was
 * "wrong". The store has to be redirected BEFORE any test file is imported —
 * i.e. at the setup module's own scope — and the directory backing it has to
 * survive every file in the worker. `createTempDir` cannot serve that: its
 * dirs are drained by the per-file sweep, which would delete the store out
 * from under files 2..N.
 *
 * ── How removal works, and why it is not `onTestFinished` or `exit` ──────
 *
 * There is no worker-teardown hook available to a setup file, and
 * `process.on("exit")` was PROBED in a vitest worker thread and does NOT fire
 * (vitest terminates its workers; 2,579 store dirs survived a five-run probe
 * with an exit handler registered). So removal is reclaim-on-next-use: each
 * call first removes any sibling store older than `WORKER_DIR_STALE_MS`. The
 * standing residue is therefore bounded by "one dir per worker for the last
 * hour" — a handful of directories holding one small SQLite file each — not
 * the unbounded growth that filled a 36G tmpfs before this owner existed.
 */
export function createWorkerTempDir(prefix: string): string {
  if (prefix.length === 0 || prefix.includes("/") || prefix.includes("\\")) {
    throw new Error(`createWorkerTempDir: invalid prefix ${JSON.stringify(prefix)}`);
  }
  const memo = WORKER_DIRS.get(prefix);
  if (memo !== undefined) return memo;

  const stem = prefix.endsWith("-") ? prefix : `${prefix}-`;
  const bucket = join(WORKER_ROOT, bucketNameFor(Date.now()));
  mkdirSync(bucket, { recursive: true });
  reclaimStaleWorkerDirs();
  // The store's own name is irrelevant to the reclaim now — its BUCKET
  // carries the time, and a whole bucket expires at once.
  const dir = mkdtempSync(join(bucket, stem));
  WORKER_DIRS.set(prefix, dir);
  return dir;
}

/**
 * Drop every expired BUCKET.
 *
 * One `readdir` of a directory holding ~7 entries, and one `rmSync` per
 * expired window. The cost does not depend on how many stores exist, which is
 * the whole point — see the note on `WORKER_ROOT` for the two earlier shapes
 * that both scaled with residue.
 */
function reclaimStaleWorkerDirs(): void {
  const cutoff = Date.now() - WORKER_DIR_STALE_MS;
  let entries: string[];
  try {
    entries = readdirSync(WORKER_ROOT);
  } catch {
    return;
  }
  for (const name of entries) {
    const end = bucketEndMs(name);
    // `null` is "not one of ours" and is never removed. A bucket goes only
    // when even its youngest possible member is past the window.
    if (end === null || end > cutoff) continue;
    try {
      rmSync(join(WORKER_ROOT, name), { recursive: true, force: true });
    } catch {
      // Another worker may be reclaiming the same bucket concurrently, or it
      // may belong to a different user. Never fail a test over cleanup.
    }
  }
}

/**
 * Remove every temp dir still on disk. Called from the setup file's `afterAll`,
 * so it runs once per test FILE. Safe to call repeatedly.
 *
 * This is the backstop for dirs created outside test context; dirs already
 * removed by `onTestFinished` are gone from `LIVE` and are not touched again.
 */
export function sweepTempDirs(): void {
  for (const dir of [...LIVE]) remove(dir);
}

/** Live (created, not yet removed) temp dirs — for the owner's own tests. */
export function liveTempDirCount(): number {
  return LIVE.size;
}

/**
 * A SECOND KEY HOME for one test — a private folder admitted as a key home
 * (`engine/src/filesystem/self-protection/key-home.ts`) INSIDE the run's own
 * private key home (armed by `vitest.config.ts`, off the system temp folder,
 * where the one admission refuses a key home), removed with the test like
 * any temp dir. The run's own key home is the default every database uses; a
 * test that needs ANOTHER key for the same database (a wrong key, a second
 * install) passes this one — also to a child process as `HARNESS_KEY_HOME`.
 */
export function createKeyHome(prefix: string): AdmittedKeyHome {
  const runKeyHome = process.env[ROOT_POLICY.selfProtection.keyHome.environmentVariable];
  if (runKeyHome === undefined) throw new Error("the run's key home is not armed (vitest.config.ts arms it for every run)");
  return admitKeyHome(createTempDir(prefix, { besidePath: join(runKeyHome, prefix) }), []);
}
