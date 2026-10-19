import { mkdirSync, opendirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { enableCompileCache, getCompileCacheDir } from "node:module";
import { dirname, join, resolve } from "node:path";

import { bestEffort } from "../../src/shared/best-effort.ts";
import { userCacheFolder } from "../../src/filesystem/user-folders.ts";
import { createOwnedTemporaryDirectory, removeOwnedTemporaryDirectory } from "../../src/filesystem/private-state.ts";

let enabled = false;

/**
 * Where the V8 compile cache lives.
 *
 * MUST BE AN EXPLICIT PATH ON A REAL FILESYSTEM. Calling `enableCompileCache()`
 * with no argument lets Node choose, and Node chooses `$TMPDIR/node-compile-cache`
 * — which on this host is a **tmpfs with a fixed inode budget**
 * (`nr_inodes=1048576`). The cache is unbounded and nothing prunes it, so it grows
 * with every distinct module version compiled by every run, worker and subprocess.
 *
 * MEASURED, 2026-07-28: it reached **1,020,671 entries / 10 GB — 97.3% of the
 * inode limit** — and exhausting it did not merely slow the suite down. It removed
 * the ability to run ANY command, because the agent harness stages every command's
 * stdout through a file under the same tmpfs. Execution, verification and the
 * ability to free the space all failed together.
 *
 * IT MUST ALSO BE OUTSIDE EVERY SCANNED TREE. The first attempt at this fix put
 * it under `node_modules/.cache`, which is off tmpfs and correctly ignored — and
 * it broke six cross-runtime reproducibility tests
 * (`FC-E001/E002`, `HCF-O003/O004`, `RPA-O003/O004`). Those assert that evidence
 * identity is **identical across three runs**, and a cache that materialises
 * inside the repository during run one makes runs two and three observe a
 * different tree. **Proven by reverting: the same file passes at exit 0 with the
 * old path and fails with the in-repo one.** Off-tmpfs was necessary and not
 * sufficient; the constraint is *off tmpfs AND outside anything the suite hashes*.
 *
 * `$XDG_CACHE_HOME` (or `~/.cache`) satisfies both: a real filesystem with a real
 * inode table, owned by the user, outside both repositories, and conventionally
 * disposable.
 */
export const COMPILE_CACHE_DIRECTORY = join(
  userCacheFolder(),
  "bridlewise",
  "v8-compile-cache",
);

/**
 * Enable the V8 compile cache for the current process and propagate its
 * directory to child processes via NODE_COMPILE_CACHE so spawned workers,
 * test subprocesses, and regeneration CLI invocations reuse the same cache
 * (~30% faster on parse-bound module loading). This is a pure optimization:
 * when the runtime cannot enable the cache the suite still runs, just
 * without the parse speedup, so failure is deliberately non-fatal.
 */
export function enableSharedCompileCache(): void {
  if (enabled) return;
  enabled = true;
  if (process.env.NODE_DISABLE_COMPILE_CACHE === "1") return;
  bestEffort(() => {
    if (getCompileCacheDir() === undefined) {
      // Native recursive mkdir retries ENOENT even when the parent exists
      // (for example on /proc), so exception handling cannot stop its loop.
      // Prepare only missing components with single mkdir calls. Existing
      // roots need no ancestor walk; inherited enabled caches need no preparation.
      // This bounds directory-creation attempts by path depth, not time.
      const missing: string[] = [];
      let directory = resolve(COMPILE_CACHE_DIRECTORY);
      while (statSync(directory, { throwIfNoEntry: false }) === undefined) {
        missing.push(directory);
        directory = dirname(directory);
      }
      for (const path of missing.reverse()) {
        try {
          mkdirSync(path);
        } catch (error) {
          // Another starter may have created the same component meanwhile.
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !statSync(path).isDirectory()) throw error;
        }
      }
      // Node also creates an opaque version directory below this root.
      // An existing root (including a symlink) does not prove that works.
      // Probe child creation nonrecursively, then remove only our empty
      // directory; do not duplicate Node's private version naming scheme.
      removeOwnedTemporaryDirectory(createOwnedTemporaryDirectory(COMPILE_CACHE_DIRECTORY, ".availability-"));
    }
    const result = enableCompileCache(COMPILE_CACHE_DIRECTORY);
    if (process.env.NODE_COMPILE_CACHE === undefined && result.directory !== undefined) {
      process.env.NODE_COMPILE_CACHE = result.directory;
    }
  });
}

/**
 * The compile-cache directory THIS process is actually writing to, or null
 * when the cache is not enabled.
 *
 * NOT the constant above: `enableCompileCache` nests a version-and-config
 * keyed subdirectory under it (driven here: `v24.18.0-x64-<hash>-<uid>`),
 * and a warmth reading taken over the parent would count the version
 * subdirectories, not the entries. Asking the runtime rather than assuming
 * the layout is the same repair the web reporter needed when a redirected
 * cache made every reading come from an untouched directory.
 */
export function compileCacheDirInUse(): string | null {
  return getCompileCacheDir() ?? null;
}

export type CompileCacheScan = Readonly<{
  /** Cache entry files present when the scan ran. */
  entries: number;
  /** Entries whose mtime is at or after `sinceMs` — the compile work paid
   *  at or after that reference. `>=` on purpose: the boundary belongs to
   *  the run, exactly as the web reporter's mtime instrument reads it. */
  writtenSince: number;
  /** Newest mtime observed across ALL entries — the witness that this walk
   *  genuinely happened. A `writtenSince` of 0 beside a newest mtime at or
   *  after the run's start is a contradiction the verdict refuses, which is
   *  what makes a computed-then-discarded count unable to read as warm. */
  newestMtimeMs: number | null;
}>;

/**
 * The suite runner's warmth instrument: one streaming walk of the compile
 * cache in use, counting entries and entries written at or after `sinceMs`.
 *
 * Returns null when the cache is disabled or its directory unreadable —
 * absence, never a zero, because "no cache to observe" says nothing about
 * coldness while "zero entries written" is a warmth claim.
 *
 * COST, MEASURED (2026-07-30): the live cache subdirectory held 1,897,399
 * entries (the parent: 20 GB across 1.93M files) and a full readdir+stat
 * walk in node took ~7.7s wall. That cost is real and it is paid AFTER the
 * run's CPU reading is taken, so it never inflates the judged figure. The
 * underlying defect — the cache is UNBOUNDED and nothing prunes it, so it
 * regrew from the 1.02M-entry incident recorded above to 1.9M in two days —
 * is filed separately; bounding the cache shrinks this walk with it.
 * `opendirSync` streams the directory instead of materialising ~1.9M names
 * in one array.
 *
 * Entries that vanish mid-scan are skipped: a deleted file was not compile
 * work the run is still paying for, and one racing unlink must not throw
 * away the whole reading.
 */
export function scanCompileCache(sinceMs: number): CompileCacheScan | null {
  const dir = compileCacheDirInUse();
  if (dir === null) return null;
  return scanCacheDirectory(dir, sinceMs);
}

/**
 * The walk itself, with the directory injectable — so the measurement can be
 * DRIVEN against a directory of planted mtimes and its exact counts
 * asserted. A measurement function no test ever drives is a function whose
 * computed-then-discarded mutant survives every guard; that exact mutant
 * survived the web reporter's first version of this instrument.
 */
// ── BOUNDED-CACHE PRUNING ────────────────────────────────────────────────
//
// The cache is otherwise UNBOUNDED and nothing else prunes it. Measured on
// this host: 1,020,671 entries / 10 GB at the recorded tmpfs incident, then —
// after the move to a real filesystem — a regrowth to 1,965,259 entries /
// 20 GB within two days, at roughly +11,500 entries per suite run that can
// NEVER be reused. The never-reusable share exists because the cache key
// covers the compiled file's identity including its PATH: the suites compile
// fixtures under per-run temp directories (`mkdtemp`), so every run's temp
// modules produce fresh keys that no later run can hit. A stable key for
// those would have to come from the runtime's own keying (out of scope
// here and recorded as such); PRUNING is the mitigation that works today.
//
// WHY AGE **AND** A CAP. Age alone bounds staleness (and clears abandoned
// node-version subdirectories) but not rate — this cache grew ~950k entries
// per day, all young. The entry cap bounds size regardless of rate; the age
// floor keeps the cap from being the only rule when growth is slow.
//
// ORDERING AGAINST THE WARMTH INSTRUMENT, stated once and relied on twice:
// the pruner runs BEFORE the run's start-stamp is taken (see
// `scripts/run-tests.ts`), and it deletes only entries whose mtime is older
// than a cutoff in the past — so the end-of-run warmth walk (which counts
// entries with mtime AT OR AFTER the start-stamp) can neither count a
// pruned entry as written nor lose a written entry to the prune. A prune
// cannot fabricate or erase "written during run" evidence by construction,
// not by discipline.

/** The declared knobs — all three from the config (`testExecution.
 *  compileCachePruning`), never defaulted here: a missing policy object
 *  means NO pruning plus a printed note, not a guessed value. */
export type CompileCachePruningPolicy = Readonly<{
  /** Entries whose mtime is older than this many days are pruned. */
  maxEntryAgeDays: number;
  /** At most this many entries survive per cache subdirectory (newest
   *  kept). Ties at the cutoff mtime survive, so the kept count can exceed
   *  the cap by the size of one mtime tie — a bounded, stated slack. */
  maxEntries: number;
  /** Wall-clock budget for the whole prune. The prune is opportunistic: on
   *  exhaustion it stops where it is and reports partial progress — a
   *  too-large cache trims over several runs instead of stalling one. */
  timeBudgetMs: number;
}>;

export type CompileCachePruneResult = Readonly<{
  /** Entries examined across all version subdirectories. */
  scannedEntries: number;
  /** Entries deleted this invocation. */
  prunedEntries: number;
  /** Entries known to remain (scanned − pruned; a partial walk undercounts
   *  the total the same way it undercounts scanned). */
  survivors: number;
  /** True when the time budget stopped the walk before it finished — the
   *  next run continues from wherever the directory order left off. */
  timeBudgetExhausted: boolean;
  tookMs: number;
}>;

/** Clock checks are batched so the budget costs one `Date.now()` per block
 *  of filesystem operations rather than one per file. */
const PRUNE_CLOCK_CHECK_EVERY = 512;

/**
 * Prune ONE cache directory under the declared policy. Exported with the
 * directory injectable so the exact survivor set can be DRIVEN over a
 * planted fixture directory and asserted — the same discipline as
 * `scanCacheDirectory`, for the same reason: a deletion routine no test
 * ever drives is the routine whose fresh-entry-eating mutant survives.
 *
 * Two walks: the first collects mtimes only (15 MB for 1.9M entries —
 * names are not held), the second deletes entries older than the single
 * derived cutoff `max(ageCutoff, capCutoff)`. One cutoff means the
 * semantics are a sentence: an entry survives iff its mtime is within the
 * age window AND among the newest `maxEntries`.
 */
export function pruneCacheDirectory(
  dir: string,
  policy: CompileCachePruningPolicy,
  nowMs: number,
  deadlineMs: number,
): CompileCachePruneResult {
  const started = Date.now();
  const ageCutoff = nowMs - policy.maxEntryAgeDays * 86_400_000;
  const mtimes: number[] = [];
  let exhausted = false;

  const walk = (onFile: (name: string, mtimeMs: number) => void): void => {
    let handle;
    try {
      handle = opendirSync(dir);
    } catch {
      return; // an unreadable directory holds nothing to prune
    }
    try {
      let sinceCheck = 0;
      for (;;) {
        if (++sinceCheck >= PRUNE_CLOCK_CHECK_EVERY) {
          sinceCheck = 0;
          if (Date.now() >= deadlineMs) { exhausted = true; return; }
        }
        const entry = handle.readSync();
        if (entry === null) return;
        if (!entry.isFile()) continue;
        try {
          onFile(entry.name, statSync(join(dir, entry.name)).mtimeMs);
        } catch {
          continue; // vanished mid-walk — not ours to prune
        }
      }
    } finally {
      handle.closeSync();
    }
  };

  walk((_name, mtimeMs) => { mtimes.push(mtimeMs); });
  const scannedEntries = mtimes.length;

  let prunedEntries = 0;
  if (!exhausted) {
    // An incomplete collection cannot support deletion, so derive this
    // cutoff only when its deletion walk will run.
    // The cap's cutoff is the maxEntries-th newest mtime; ties survive.
    let capCutoff = Number.NEGATIVE_INFINITY;
    if (mtimes.length > policy.maxEntries) {
      mtimes.sort((a, b) => b - a);
      capCutoff = mtimes[policy.maxEntries - 1]!;
    }
    const cutoff = Math.max(ageCutoff, capCutoff);
    walk((name, mtimeMs) => {
      if (mtimeMs < cutoff) {
        // One EPERM/ENOENT must not abort the prune; a failed unlink is a
        // survivor and `bestEffort` says so instead of swallowing it.
        bestEffort(() => {
          unlinkSync(join(dir, name));
          prunedEntries += 1;
        });
      }
    });
  }
  return {
    scannedEntries,
    prunedEntries,
    survivors: scannedEntries - prunedEntries,
    timeBudgetExhausted: exhausted,
    tookMs: Date.now() - started,
  };
}

/**
 * Prune every version subdirectory under the cache ROOT (the constant this
 * module enables the cache at). The root is used rather than only
 * `compileCacheDirInUse()` because abandoned node-version subdirectories
 * are exactly the entries nothing will ever read again, and the directory
 * in use is one of several. One shared budget covers the whole prune.
 */
export function pruneCompileCacheRoot(
  policy: CompileCachePruningPolicy,
  nowMs: number = Date.now(),
): CompileCachePruneResult {
  const deadlineMs = Date.now() + policy.timeBudgetMs;
  let scannedEntries = 0;
  let prunedEntries = 0;
  let exhausted = false;
  const started = Date.now();
  let subdirs: readonly string[];
  try {
    subdirs = readdirSync(COMPILE_CACHE_DIRECTORY, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(COMPILE_CACHE_DIRECTORY, d.name));
  } catch {
    subdirs = [];
  }
  for (const dir of subdirs) {
    if (Date.now() >= deadlineMs) { exhausted = true; break; }
    const r = pruneCacheDirectory(dir, policy, nowMs, deadlineMs);
    scannedEntries += r.scannedEntries;
    prunedEntries += r.prunedEntries;
    exhausted = exhausted || r.timeBudgetExhausted;
  }
  return {
    scannedEntries,
    prunedEntries,
    survivors: scannedEntries - prunedEntries,
    timeBudgetExhausted: exhausted,
    tookMs: Date.now() - started,
  };
}

export function scanCacheDirectory(dir: string, sinceMs: number): CompileCacheScan | null {
  let entries = 0;
  let writtenSince = 0;
  let newestMtimeMs: number | null = null;
  try {
    const handle = opendirSync(dir);
    try {
      for (;;) {
        const entry = handle.readSync();
        if (entry === null) break;
        if (!entry.isFile()) continue;
        try {
          const mtimeMs = statSync(join(dir, entry.name)).mtimeMs;
          entries += 1;
          if (mtimeMs >= sinceMs) writtenSince += 1;
          if (newestMtimeMs === null || mtimeMs > newestMtimeMs) newestMtimeMs = mtimeMs;
        } catch {
          // A file deleted between readdir and stat was not compile work
          // this run is paying for; skip it rather than losing the reading.
          continue;
        }
      }
    } finally {
      handle.closeSync();
    }
  } catch {
    return null;
  }
  return { entries, writtenSince, newestMtimeMs };
}
