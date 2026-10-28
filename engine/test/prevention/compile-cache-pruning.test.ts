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
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createTempDir } from "../support/temp-dir.ts";
import {
  pruneCompileCache,
  parsePruneStamp,
  PRUNE_STAMP_MALFORMED,
  pruneCompileCacheAtEnablement,
  pruneStamp,
  pruneStampText,
  pruneSummary,
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
  maxDeletionsPerPrune: 1_000,
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

const prune = (root: string, policy: CompileCachePruningPolicy = POLICY) => pruneCompileCache(root, policy, NOW);

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
  const summary = pruneSummary(result, { ...POLICY, maxBytes: 4 * KIB });
  assert.ok(summary.line.endsWith("— STILL OVER THE BOUND: the rest is in use"), summary.line);
  assert.equal(summary.loud, true, "a bound the cache cannot meet is reported always, not as debug");
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

test("compile-cache bound: INCREMENTAL, never timed — a prune deletes at most its cap, the least recently used first, records that work is left, and the next enabler continues at once", () => {
  const { root, version } = cacheRoot("cc-incremental-");
  for (let index = 0; index < 5; index += 1) plant(version, `stale-${String(index)}`, 1, NOW - (100 + index) * HOUR);
  const policy = { ...POLICY, maxDeletionsPerPrune: 2 };
  const first = pruneCompileCacheAtEnablement(policy, root, NOW);
  assert.deepEqual(readdirSync(version).sort(), ["stale-0", "stale-1", "stale-2"], "the two least recently used went first");
  assert.match(first?.line ?? "", /the deletion cap \(2\) left prunable entries: the next enabler continues$/u);
  // Within the interval, yet the last prune left work: the next enabler continues.
  pruneCompileCacheAtEnablement(policy, root, NOW + 1_000);
  assert.deepEqual(readdirSync(version), ["stale-0"]);
  pruneCompileCacheAtEnablement(policy, root, NOW + 2_000);
  assert.deepEqual(readdirSync(version), [], "the backlog is gone across enablers, with no clock judging any of them");
  assert.equal(pruneCompileCacheAtEnablement(policy, root, NOW + 3_000), null, "no work left and within the interval: no prune");
});

test("compile-cache bound: at enablement, at most one prune per interval (a stamp in the root); an unreadable root is a loud refusal, never a silent skip", () => {
  const { root, version } = cacheRoot("cc-interval-");
  plant(version, "abandoned", 1, NOW - 100 * HOUR);
  const first = pruneCompileCacheAtEnablement(POLICY, root, NOW);
  assert.ok(first?.line.startsWith("prune: 1 of 1 entries"), first?.line);
  assert.ok(existsSync(join(root, ".last-prune")), "the prune stamps the root");
  plant(version, "abandoned-again", 1, NOW - 100 * HOUR);
  assert.equal(pruneCompileCacheAtEnablement(POLICY, root, NOW + 1_000), null, "within the interval, no second prune");
  assert.deepEqual(readdirSync(version), ["abandoned-again"]);
  const notADirectory = join(createTempDir("cc-file-root-"), "a-file");
  writeFileSync(notADirectory, "x");
  assert.throws(() => pruneCompileCacheAtEnablement(POLICY, notADirectory, NOW), /ENOTDIR/u);
});

test("compile-cache bound: the ENABLER prunes, reports through the logger on STDERR (stdout stays the runner's data), says a missing policy, and says a prune that FAILED", () => {
  const owner = pathToFileURL(join(import.meta.dirname, "..", "..", "scripts", "tooling", "compile-cache.ts")).href;
  const run = (policy: string, plant?: (cacheHome: string) => void) => {
    const cacheHome = createTempDir("cc-enabler-");
    plant?.(cacheHome);
    const environment: NodeJS.ProcessEnv = { ...process.env, XDG_CACHE_HOME: cacheHome };
    delete environment["NODE_COMPILE_CACHE"];
    delete environment["NODE_DISABLE_COMPILE_CACHE"];
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `const { enableSharedCompileCache } = await import(${JSON.stringify(owner)}); enableSharedCompileCache(${policy});`], { env: environment, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    return child;
  };
  const bounded = run(JSON.stringify(POLICY));
  assert.equal(bounded.stdout, "", "nothing on stdout: a runner reads its stdout as data");
  const unbounded = run("undefined");
  assert.equal(unbounded.stdout, "");
  assert.ok(unbounded.stderr.includes("the shared V8 compile cache is NOT bounded"), unbounded.stderr);
  // A version folder this user cannot read: the prune's walk fails, and the enabler SAYS so.
  const failed = run(JSON.stringify(POLICY), (cacheHome) => {
    const unreadable = join(cacheHome, "bridlewise", "v8-compile-cache", "v0-unreadable");
    mkdirSync(unreadable, { recursive: true });
    chmodSync(unreadable, 0o000);
  });
  assert.equal(failed.stdout, "");
  assert.ok(failed.stderr.includes("PRUNE FAILED, the cache is NOT bounded this time"), failed.stderr);
});

test("compile-cache bound: the prune stamp is ONE typed record — written by its one writer, read back field by field — and a malformed stamp is a typed refusal, never a substring guess", () => {
  assert.deepEqual(parsePruneStamp(pruneStampText(pruneStamp(NOW, true))), { schema: "compile-cache-prune-stamp/1", prunedAtMs: NOW, workLeft: true });
  assert.deepEqual(parsePruneStamp(pruneStampText(pruneStamp(NOW, false))), { schema: "compile-cache-prune-stamp/1", prunedAtMs: NOW, workLeft: false });
  const refused = (text: string, why: string) => {
    assert.throws(() => parsePruneStamp(text), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, PRUNE_STAMP_MALFORMED);
      assert.ok((error as Error).message.includes(`is malformed: ${why}.`), (error as Error).message);
      return true;
    });
  };
  // The pre-record text form: its "work-left" word is NOT read as a field.
  refused("2026-10-28T12:00:00.000Z work-left\n", "not JSON");
  refused("[]", "not a JSON object");
  refused("null", "not a JSON object");
  refused(JSON.stringify({ schema: "compile-cache-prune-stamp/1", prunedAtMs: NOW }), "its fields are [prunedAtMs, schema], not [prunedAtMs, schema, workLeft]");
  refused(JSON.stringify({ schema: "compile-cache-prune-stamp/1", prunedAtMs: NOW, workLeft: true, note: "work-left" }), "its fields are [note, prunedAtMs, schema, workLeft], not [prunedAtMs, schema, workLeft]");
  refused(JSON.stringify({ schema: "compile-cache-prune-stamp/2", prunedAtMs: NOW, workLeft: true }), "its schema is not compile-cache-prune-stamp/1");
  refused(JSON.stringify({ schema: "compile-cache-prune-stamp/1", prunedAtMs: "now", workLeft: true }), "prunedAtMs is not a finite, non-negative instant");
  refused(JSON.stringify({ schema: "compile-cache-prune-stamp/1", prunedAtMs: -1, workLeft: true }), "prunedAtMs is not a finite, non-negative instant");
  refused(JSON.stringify({ schema: "compile-cache-prune-stamp/1", prunedAtMs: NOW, workLeft: "work-left" }), "workLeft is not a boolean");
  // At enablement: the stamp the prune wrote is that record, and a malformed one refuses the prune (the enabler says PRUNE FAILED).
  const { root, version } = cacheRoot("cc-stamp-");
  plant(version, "abandoned", 1, NOW - 100 * HOUR);
  pruneCompileCacheAtEnablement(POLICY, root, NOW);
  assert.deepEqual(parsePruneStamp(readFileSync(join(root, ".last-prune"), "utf8")), { schema: "compile-cache-prune-stamp/1", prunedAtMs: NOW, workLeft: false });
  writeFileSync(join(root, ".last-prune"), "2026-10-28T12:00:00.000Z work-left\n");
  plant(version, "abandoned-again", 1, NOW - 100 * HOUR);
  assert.throws(() => pruneCompileCacheAtEnablement(POLICY, root, NOW + 1_000), (error: unknown) => (error as { code?: unknown }).code === PRUNE_STAMP_MALFORMED);
  assert.deepEqual(readdirSync(version), ["abandoned-again"], "a refused stamp prunes nothing on a guess");
});
