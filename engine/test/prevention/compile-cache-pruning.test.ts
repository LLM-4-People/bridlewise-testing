// THE COMPILE-CACHE BOUND, DRIVEN OVER PLANTED SIZES AND LAST USES WITH EXACT SURVIVORS.
//
// The shared V8 compile cache keys an entry per compiled file per PATH, so
// every worktree adds a full copy. Measured 2026-10-28: 20 GB / 307k files
// (the host disk at 98%) under the old bound, which kept the newest 400,000
// entries PER DIRECTORY and so never pruned a cache of large entries.
// `scripts/tooling/compile-cache.ts` now bounds the cache's TOTAL BYTES,
// least-recently-used first, plus an age since last use, and never prunes an
// entry used within `inUseMinutes`. A deletion routine no test drives is the
// routine whose in-use-entry-eating mutant survives every guard — so every
// branch is driven against a fixture root with planted sizes, mtimes and
// atimes, and the SURVIVING SET is asserted by name, not by count.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createTempDir } from "../support/temp-dir.ts";
import {
  pruneCompileCache,
  pruneCompileCacheAtEnablement,
  pruneSummaryLine,
  type CompileCachePruningPolicy,
} from "../../scripts/tooling/compile-cache.ts";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const HOUR = 3_600_000;
const KIB = 1024;

const POLICY: CompileCachePruningPolicy = {
  maxBytes: 10 * KIB,
  maxEntryAgeHours: 72,
  inUseMinutes: 120,
  intervalMinutes: 60,
  timeBudgetMs: 60_000,
};

/** A cache root with one version subdirectory, as Node lays it out. */
function cacheRoot(prefix: string): Readonly<{ root: string; version: string }> {
  const root = createTempDir(prefix);
  const version = join(root, "v24.20.0-x64-plant-1000");
  mkdirSync(version);
  return { root, version };
}

/** Plant one entry of `kib` KiB, last written at `mtimeMs` and last read at `atimeMs`. */
function plant(directory: string, name: string, kib: number, mtimeMs: number, atimeMs: number = mtimeMs): void {
  const path = join(directory, name);
  writeFileSync(path, Buffer.alloc(kib * KIB, 1));
  utimesSync(path, atimeMs / 1000, mtimeMs / 1000);
}

const prune = (root: string, policy: CompileCachePruningPolicy = POLICY) => pruneCompileCache(root, policy, NOW, Date.now() + policy.timeBudgetMs);

test("compile-cache bound: a FILLED cache is pruned least-recently-used first to its byte bound — exact survivors", () => {
  const { root, version } = cacheRoot("cc-filled-");
  // 16 KiB of entries, all older than the in-use window, all younger than the age bound; bound 10 KiB.
  plant(version, "oldest", 4, NOW - 60 * HOUR);
  plant(version, "older", 4, NOW - 50 * HOUR);
  plant(version, "newer", 4, NOW - 40 * HOUR);
  plant(version, "newest", 4, NOW - 30 * HOUR);
  const result = prune(root);
  assert.deepEqual(readdirSync(version).sort(), ["newer", "newest"], "the least recently used go first, until the cache fits");
  assert.equal(result.scannedBytes, 16 * KIB);
  assert.equal(result.prunedBytes, 8 * KIB);
  assert.equal(result.survivorBytes, 8 * KIB);
  assert.equal(result.overBoundInUse, false);
});

test("compile-cache bound: entries IN USE survive the byte bound, and a cache that stays over it says so", () => {
  const { root, version } = cacheRoot("cc-in-use-");
  plant(version, "idle", 4, NOW - 48 * HOUR);
  plant(version, "used-an-hour-ago", 4, NOW - 1 * HOUR);
  plant(version, "written-now", 4, NOW - 1_000);
  const result = prune(root, { ...POLICY, maxBytes: 4 * KIB });
  assert.deepEqual(readdirSync(version).sort(), ["used-an-hour-ago", "written-now"], "only the idle entry may go; entries used within inUseMinutes are never pruned");
  assert.equal(result.overBoundInUse, true, "still over the bound because the rest is in use");
  assert.match(pruneSummaryLine(result, { ...POLICY, maxBytes: 4 * KIB }), /STILL OVER THE BOUND: the rest is in use/u);
});

test("compile-cache bound: LAST USE is the later of written and READ — an old entry read recently is recent", () => {
  const { root, version } = cacheRoot("cc-atime-");
  plant(version, "written-long-ago-read-recently", 4, NOW - 70 * HOUR, NOW - 2 * HOUR);
  plant(version, "written-recently-never-read", 4, NOW - 40 * HOUR);
  plant(version, "idle", 4, NOW - 50 * HOUR);
  prune(root, { ...POLICY, maxBytes: 8 * KIB });
  assert.deepEqual(readdirSync(version).sort(), ["written-long-ago-read-recently", "written-recently-never-read"]);
});

test("compile-cache bound: an entry unused past the age bound goes even when the cache is under its byte bound", () => {
  const { root, version } = cacheRoot("cc-age-");
  plant(version, "abandoned", 1, NOW - 100 * HOUR);
  plant(version, "recent", 1, NOW - 10 * HOUR);
  const result = prune(root);
  assert.deepEqual(readdirSync(version), ["recent"]);
  assert.equal(result.prunedEntries, 1);
});

test("compile-cache bound: a walk the time budget cut short deletes NOTHING and says so", () => {
  const { root, version } = cacheRoot("cc-budget-");
  for (let index = 0; index < 600; index += 1) plant(version, `stale-${String(index)}`, 1, NOW - 100 * HOUR);
  const result = pruneCompileCache(root, POLICY, NOW, Date.now() - 1);
  assert.equal(result.timeBudgetExhausted, true);
  assert.equal(result.prunedEntries, 0);
  assert.equal(readdirSync(version).length, 600);
  assert.ok(pruneSummaryLine(result, POLICY).endsWith("— TIME BUDGET EXHAUSTED before the walk finished: NOTHING was deleted, the cache is NOT bounded this time"));
});

test("compile-cache bound: at enablement, at most one prune per interval (a stamp in the root); an unreadable root is a loud refusal, never a silent skip", () => {
  const { root, version } = cacheRoot("cc-interval-");
  plant(version, "abandoned", 1, NOW - 100 * HOUR);
  const first = pruneCompileCacheAtEnablement(POLICY, root, NOW);
  assert.match(first ?? "", /^\[compile-cache\] prune: 1 of 1 entries/u);
  assert.ok(existsSync(join(root, ".last-prune")), "the prune stamps the root");
  plant(version, "abandoned-again", 1, NOW - 100 * HOUR);
  assert.equal(pruneCompileCacheAtEnablement(POLICY, root, Date.now()), null, "within the interval, no second prune");
  assert.deepEqual(readdirSync(version), ["abandoned-again"]);
  const notADirectory = join(createTempDir("cc-file-root-"), "a-file");
  writeFileSync(notADirectory, "x");
  assert.throws(() => pruneCompileCacheAtEnablement(POLICY, notADirectory, NOW), /ENOTDIR/u);
});

test("compile-cache bound: the ENABLER prunes and says so, and an enabler with no policy says the cache is NOT bounded", () => {
  const owner = pathToFileURL(join(import.meta.dirname, "..", "..", "scripts", "tooling", "compile-cache.ts")).href;
  const run = (policy: string): string => {
    const cacheHome = createTempDir("cc-enabler-");
    const environment: NodeJS.ProcessEnv = { ...process.env, XDG_CACHE_HOME: cacheHome };
    delete environment["NODE_COMPILE_CACHE"];
    delete environment["NODE_DISABLE_COMPILE_CACHE"];
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `const { enableSharedCompileCache } = await import(${JSON.stringify(owner)}); enableSharedCompileCache(${policy});`], { env: environment, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
  };
  assert.match(run(JSON.stringify(POLICY)), /^\[compile-cache\] prune: /mu, "the enabler bounds the cache it enables");
  assert.match(run("undefined"), /the shared V8 compile cache is NOT bounded/u, "no policy is said, never a silent skip");
});
