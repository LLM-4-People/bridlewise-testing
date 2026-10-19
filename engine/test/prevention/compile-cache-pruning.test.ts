// THE COMPILE-CACHE PRUNER, DRIVEN OVER PLANTED MTIMES WITH EXACT SURVIVORS.
//
// The shared V8 compile cache is unbounded by the runtime and was measured at
// 1,965,259 entries / 20 GB two days after a full clear (~11.5k never-reusable
// temp-path entries per suite run). `scripts/compile-cache.ts` now owns a
// bounded-cache policy: an entry survives iff its mtime is within the age
// window AND among the newest `maxEntries`. A deletion routine no test drives
// is the routine whose fresh-entry-eating mutant survives every guard — so
// every branch here is driven against a fixture directory with planted
// mtimes, and the SURVIVING SET is asserted by name, not by count.
//
// `pruneCompileCacheRoot` itself is a thin fan-out over the real cache root
// (a module-load constant), so the injectable `pruneCacheDirectory` is the
// driven surface — the same seam `scanCacheDirectory` already earns its
// driven test through, for the same recorded reason.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createTempDir } from "../support/temp-dir.ts";
import {
  pruneCacheDirectory,
  type CompileCachePruningPolicy,
} from "../../scripts/tooling/compile-cache.ts";

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);
const DAY = 86_400_000;

/** Plant one cache-entry file with an exact mtime. */
function plant(dir: string, name: string, mtimeMs: number): void {
  const p = join(dir, name);
  writeFileSync(p, "compiled-bytes");
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
}

const POLICY: CompileCachePruningPolicy = {
  maxEntryAgeDays: 7,
  maxEntries: 4,
  timeBudgetMs: 60_000,
};

test("pruner: exact survivors — within the age window AND among the newest maxEntries", () => {
  const dir = createTempDir("compile-cache-prune-");
  // Three beyond the 7-day window, six within it. With a cap of 4, the
  // survivors are exactly the four NEWEST of the six in-window entries.
  plant(dir, "stale-a", NOW - 9 * DAY);
  plant(dir, "stale-b", NOW - 8 * DAY);
  plant(dir, "stale-c", NOW - 7 * DAY - 1);
  plant(dir, "old-in-window", NOW - 6 * DAY);
  plant(dir, "older-mid", NOW - 5 * DAY);
  plant(dir, "mid", NOW - 3 * DAY);
  plant(dir, "young", NOW - 1 * DAY);
  plant(dir, "fresh", NOW - 1000);
  plant(dir, "freshest", NOW);
  const result = pruneCacheDirectory(dir, POLICY, NOW, Date.now() + POLICY.timeBudgetMs);
  assert.deepEqual(
    readdirSync(dir).sort(),
    ["fresh", "freshest", "mid", "young"],
    "the survivor SET must be exactly the newest maxEntries within the age window",
  );
  assert.equal(result.scannedEntries, 9);
  assert.equal(result.prunedEntries, 5);
  assert.equal(result.survivors, 4);
  assert.equal(result.timeBudgetExhausted, false);
});

// ── WHAT "FRESH" DOES AND DOES NOT BUY, decided by mechanism ───────────────
// This test used to certify "fresh entries are NEVER deleted — under any
// policy that admits at least one entry", and its fixture never bound the
// cap (two entries, maxEntries 2), so the claim was wider than the code:
// with maxEntries 1 a 2-second-old entry prunes. That is the CAP WORKING,
// not a defect — maxEntries is the operator's hard bound, and an age-based
// exemption for "fresh" entries would unbound it exactly when a runaway run
// floods the cache with fresh never-reusable writes, which is the measured
// growth this policy exists to stop. The warmth instrument is protected by
// ORDERING, not by an exemption: the prune runs before the run's
// start-stamp (`beginMeasuredRun` in scripts/run-tests.ts, order pinned by
// test), so it can only ever delete entries whose mtime predates the stamp
// the warmth walk reads against. So the honest invariant is narrower, and
// both directions are driven: freshness protects an entry only from the AGE
// arm, never from the cap.
test("pruner: freshness exempts an entry from the age arm, NOT from the cap", () => {
  const capBinds = createTempDir("compile-cache-fresh-cap-");
  plant(capBinds, "written-this-run", NOW - 50);
  plant(capBinds, "written-just-before", NOW - 5_000);
  const bound = pruneCacheDirectory(
    capBinds,
    { maxEntryAgeDays: 1, maxEntries: 1, timeBudgetMs: 60_000 },
    NOW,
    Date.now() + 60_000,
  );
  assert.equal(bound.prunedEntries, 1, "the cap must bind even against a seconds-old entry");
  assert.deepEqual(readdirSync(capBinds).sort(), ["written-this-run"],
    "when the cap binds, the OLDEST in-window entry is the one that goes");

  const capAdmits = createTempDir("compile-cache-fresh-");
  plant(capAdmits, "written-this-run", NOW - 50);
  plant(capAdmits, "written-just-before", NOW - 5_000);
  const unbound = pruneCacheDirectory(
    capAdmits,
    { maxEntryAgeDays: 1, maxEntries: 2, timeBudgetMs: 60_000 },
    NOW,
    Date.now() + 60_000,
  );
  assert.equal(unbound.prunedEntries, 0, "a policy whose cap admits every in-window entry deletes nothing fresh");
  assert.deepEqual(readdirSync(capAdmits).sort(), ["written-just-before", "written-this-run"]);
});

test("pruner: entries tied at the cap's cutoff mtime all survive (the stated bounded slack)", () => {
  const dir = createTempDir("compile-cache-tie-");
  const tieMtime = NOW - 2 * DAY;
  plant(dir, "tie-a", tieMtime);
  plant(dir, "tie-b", tieMtime);
  plant(dir, "tie-c", tieMtime);
  plant(dir, "newest", NOW);
  const result = pruneCacheDirectory(
    dir,
    { maxEntryAgeDays: 7, maxEntries: 2, timeBudgetMs: 60_000 },
    NOW,
    Date.now() + 60_000,
  );
  // Cap is 2, but the cutoff lands ON the tie: nothing is STRICTLY older
  // than the cutoff, so all four survive — kept can exceed the cap by one
  // mtime tie, and only by that.
  assert.equal(result.prunedEntries, 0);
  assert.equal(readdirSync(dir).length, 4);
});

test("pruner: an exhausted time budget stops the walk and reports it — partial progress, never a stall", () => {
  const dir = createTempDir("compile-cache-budget-");
  for (let i = 0; i < 600; i++) plant(dir, `stale-${String(i)}`, NOW - 30 * DAY);
  // The deadline is already in the past, so the first batched clock check
  // stops the collection walk before any deletion pass runs.
  const originalSort = Array.prototype.sort;
  let sortCalls = 0;
  Array.prototype.sort = function <T>(this: T[], compare?: (a: T, b: T) => number): T[] {
    sortCalls += 1;
    return Reflect.apply(originalSort, this, [compare]) as T[];
  };
  let result;
  try {
    result = pruneCacheDirectory(dir, POLICY, NOW, Date.now() - 1);
  } finally { Array.prototype.sort = originalSort; }
  assert.equal(result.timeBudgetExhausted, true);
  assert.equal(result.prunedEntries, 0, "an exhausted collection walk must not guess at deletions");
  assert.equal(readdirSync(dir).length, 600, "every entry survives an exhausted walk");
  assert.ok(result.scannedEntries > POLICY.maxEntries, "the partial collection actually reaches the cap-selection branch");
  assert.equal(sortCalls, 0, "an exhausted collection must not sort a cutoff that no deletion walk will consume");
});

test("pruner: non-file entries are untouched and an unreadable directory prunes nothing", () => {
  const dir = createTempDir("compile-cache-subdir-");
  mkdirSync(join(dir, "a-subdirectory"));
  plant(dir, "stale", NOW - 30 * DAY);
  const result = pruneCacheDirectory(dir, POLICY, NOW, Date.now() + 60_000);
  assert.equal(result.prunedEntries, 1);
  assert.deepEqual(readdirSync(dir), ["a-subdirectory"]);
  const missing = pruneCacheDirectory(join(dir, "does-not-exist"), POLICY, NOW, Date.now() + 60_000);
  assert.equal(missing.scannedEntries, 0);
  assert.equal(missing.prunedEntries, 0);
});
