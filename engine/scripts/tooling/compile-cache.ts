import { mkdirSync, opendirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
 *
 * THE ENABLER BOUNDS IT. The process that enables the cache for a tree of
 * processes (it did not inherit `NODE_COMPILE_CACHE`) prunes it to `policy`
 * (`testExecution.compileCachePruning`, see BOUNDED-CACHE PRUNING below)
 * before anything is compiled, at most once per interval. No silent
 * disable: no policy, or a prune that fails, is said on stdout.
 */
export function enableSharedCompileCache(policy: CompileCachePruningPolicy | undefined): void {
  if (enabled) return;
  enabled = true;
  if (process.env.NODE_DISABLE_COMPILE_CACHE === "1") return;
  const inherited = process.env.NODE_COMPILE_CACHE !== undefined;
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
  // Only the enabler bounds the cache, and only a cache that is actually on.
  if (inherited || getCompileCacheDir() === undefined) return;
  if (policy === undefined) {
    process.stdout.write(
      "[compile-cache] no pruning policy declared (testExecution.compileCachePruning in bridlewise.config.json): " +
        "the shared V8 compile cache is NOT bounded. Declare { maxBytes, maxEntryAgeHours, inUseMinutes, intervalMinutes, timeBudgetMs }; nothing is guessed.\n",
    );
    return;
  }
  try {
    const line = pruneCompileCacheAtEnablement(policy);
    if (line !== null) process.stdout.write(`${line}\n`);
  } catch (error) {
    process.stdout.write(`[compile-cache] PRUNE FAILED, the cache is NOT bounded this time: ${error instanceof Error ? error.message : String(error)}\n`);
  }
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
// WHAT BOUNDS IT NOW: BYTES AND LAST USE, NOT A COUNT PER DIRECTORY.
// Measured 2026-10-28: 20 GB / 307k files (the host disk at 98%), under a
// policy that kept the newest 400,000 entries PER DIRECTORY — a cache of
// large entries (about 63 KB each, keyed per compiled file per PATH, so every
// worktree adds a full copy) never reached the count, and nothing bounded its
// size. The bound is now the cache's TOTAL BYTES, pruned least-recently-used
// first, plus an age since last use; an entry used within `inUseMinutes` is
// never pruned (the runs using it are live).
//
// "LAST USE" is the later of an entry's mtime (written) and atime (read). A
// filesystem mounted `relatime` (this host's) refreshes atime at most once a
// day, so an entry only READ lately may look older than it is. Pruning it is
// safe: a missing entry is a cache miss, and the process that wanted it
// recompiles. The in-use window protects the live runs' work, not
// correctness — measured 2026-10-28: with a one-day window every entry was
// "in use" (10.5 GiB written in a day across worktrees) and nothing could be
// pruned, so the window is short (`inUseMinutes`).
//
// WHEN: at ENABLEMENT, by the process that enables the cache for a tree of
// processes (one that did not inherit `NODE_COMPILE_CACHE`), at most once per
// `intervalMinutes` (a stamp file in the cache root), before anything is
// compiled — so the warmth instrument's ordering holds as before: the prune
// precedes the run's start-stamp and deletes only entries last used before
// it.
//
// NO SILENT DISABLE: a missing policy, a prune that fails, a walk the time
// budget cut short, and a cache that stays over its bound because the rest is
// in use are each SAID, on stdout, in one line.

/** The declared bound (`testExecution.compileCachePruning`), never defaulted here. */
export type CompileCachePruningPolicy = Readonly<{
  /** The cache's total size the prune brings it down to (least-recently-used first). */
  maxBytes: number;
  /** An entry unused for this many hours is pruned whatever the size. */
  maxEntryAgeHours: number;
  /** An entry used within this many minutes is never pruned (in use). */
  inUseMinutes: number;
  /** At most one prune per this many minutes, across every process enabling the cache. */
  intervalMinutes: number;
  /** Wall-clock budget for one prune: on exhaustion it stops before deleting anything and says so. */
  timeBudgetMs: number;
}>;

export type CompileCachePruneResult = Readonly<{
  scannedEntries: number;
  scannedBytes: number;
  prunedEntries: number;
  prunedBytes: number;
  survivorBytes: number;
  /** True when, after pruning everything allowed, the cache is still over `maxBytes`: the rest is in use. */
  overBoundInUse: boolean;
  /** Entries whose unlink failed (each a survivor), said in the summary line. */
  unlinkFailures: number;
  /** True when the time budget stopped the walk before it finished: nothing was deleted. */
  timeBudgetExhausted: boolean;
  tookMs: number;
}>;

/** Clock checks are batched so the budget costs one `Date.now()` per block of filesystem operations. */
const PRUNE_CLOCK_CHECK_EVERY = 512;

type CacheEntry = { readonly path: string; readonly bytes: number; readonly lastUsedMs: number };

/**
 * Prune the cache rooted at `root` (its version subdirectories) under
 * `policy`, as of `nowMs`. Exported with the root injectable so the exact
 * survivor set is DRIVEN over a planted fixture and asserted — a deletion
 * routine no test drives is the routine whose in-use-entry-eating mutant
 * survives every guard.
 *
 * One collection walk (path, size, last use), then deletion: first every
 * entry unused for `maxEntryAgeHours`, then — while the total is over
 * `maxBytes` — the least recently used, never one used within
 * `inUseMinutes`. An incomplete walk deletes nothing.
 */
export function pruneCompileCache(root: string, policy: CompileCachePruningPolicy, nowMs: number, deadlineMs: number): CompileCachePruneResult {
  const started = Date.now();
  const entries: CacheEntry[] = [];
  let exhausted = false;
  let sinceCheck = 0;
  let subdirectories: readonly string[] = [];
  try {
    subdirectories = readdirSync(root, { withFileTypes: true }).filter((one) => one.isDirectory()).map((one) => join(root, one.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  collect: for (const directory of subdirectories) {
    const handle = opendirSync(directory);
    try {
      for (;;) {
        if (++sinceCheck >= PRUNE_CLOCK_CHECK_EVERY) {
          sinceCheck = 0;
          if (Date.now() >= deadlineMs) { exhausted = true; break collect; }
        }
        const entry = handle.readSync();
        if (entry === null) break;
        if (!entry.isFile()) continue;
        const path = join(directory, entry.name);
        const facts = statSync(path, { throwIfNoEntry: false });
        if (facts === undefined) continue; // vanished mid-walk: not ours to prune
        entries.push({ path, bytes: facts.size, lastUsedMs: Math.max(facts.mtimeMs, facts.atimeMs) });
      }
    } finally {
      handle.closeSync();
    }
  }
  const scannedBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  let prunedEntries = 0;
  let prunedBytes = 0;
  let unlinkFailures = 0;
  const remove = (entry: CacheEntry): void => {
    try {
      unlinkSync(entry.path);
      prunedEntries += 1;
      prunedBytes += entry.bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // another prune took it
      unlinkFailures += 1;
    }
  };
  if (!exhausted) {
    const ageCutoff = nowMs - policy.maxEntryAgeHours * 3_600_000;
    const inUseCutoff = nowMs - policy.inUseMinutes * 60_000;
    const kept: CacheEntry[] = [];
    for (const entry of entries) {
      if (entry.lastUsedMs < ageCutoff && entry.lastUsedMs < inUseCutoff) remove(entry);
      else kept.push(entry);
    }
    kept.sort((a, b) => a.lastUsedMs - b.lastUsedMs);
    let total = scannedBytes - prunedBytes;
    for (const entry of kept) {
      if (total <= policy.maxBytes || entry.lastUsedMs >= inUseCutoff) break;
      remove(entry);
      total -= entry.bytes;
    }
  }
  const survivorBytes = scannedBytes - prunedBytes;
  return {
    scannedEntries: entries.length,
    scannedBytes,
    prunedEntries,
    prunedBytes,
    survivorBytes,
    overBoundInUse: !exhausted && survivorBytes > policy.maxBytes,
    unlinkFailures,
    timeBudgetExhausted: exhausted,
    tookMs: Date.now() - started,
  };
}

/** The stamp in the cache root whose mtime is the last prune's instant. */
const PRUNE_STAMP = ".last-prune";

/** One line saying what the prune did, or why the bound is not met. */
export function pruneSummaryLine(result: CompileCachePruneResult, policy: CompileCachePruningPolicy): string {
  const gib = (bytes: number): string => `${(bytes / 1_073_741_824).toFixed(2)} GiB`;
  const base = `[compile-cache] prune: ${String(result.prunedEntries)} of ${String(result.scannedEntries)} entries ` +
    `(${gib(result.prunedBytes)} of ${gib(result.scannedBytes)}) removed in ${String(result.tookMs)}ms; ${gib(result.survivorBytes)} kept ` +
    `(bound: ${gib(policy.maxBytes)}, unused ${String(policy.maxEntryAgeHours)}h pruned, used within ${String(policy.inUseMinutes)}min kept)`;
  if (result.timeBudgetExhausted) return `${base} — TIME BUDGET EXHAUSTED before the walk finished: NOTHING was deleted, the cache is NOT bounded this time`;
  const notes: string[] = [];
  if (result.overBoundInUse) notes.push("STILL OVER THE BOUND: the rest is in use");
  if (result.unlinkFailures > 0) notes.push(`${String(result.unlinkFailures)} entr(ies) could not be removed`);
  return notes.length === 0 ? base : `${base} — ${notes.join("; ")}`;
}

/**
 * Prune the shared cache root at enablement (see the header above): when no
 * prune ran within `policy.intervalMinutes`, prune and stamp. Answers the
 * line to print, or null when the interval has not passed.
 */
export function pruneCompileCacheAtEnablement(policy: CompileCachePruningPolicy, root: string = COMPILE_CACHE_DIRECTORY, nowMs: number = Date.now()): string | null {
  const stamp = join(root, PRUNE_STAMP);
  const last = statSync(stamp, { throwIfNoEntry: false });
  if (last !== undefined && nowMs - last.mtimeMs < policy.intervalMinutes * 60_000) return null;
  const result = pruneCompileCache(root, policy, nowMs, Date.now() + policy.timeBudgetMs);
  if (!result.timeBudgetExhausted) writeFileSync(stamp, `${new Date(nowMs).toISOString()}\n`);
  return pruneSummaryLine(result, policy);
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
