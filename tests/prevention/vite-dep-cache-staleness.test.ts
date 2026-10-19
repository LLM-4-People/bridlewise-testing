// @vitest-environment node
/**
 * The Vite dep-optimizer staleness verdict, driven over fixtures.
 *
 * The defect class: after editing `server/` or `engine/src/`, the dev server
 * kept serving the dependency graph of the tree the cache was built in — a
 * restart did NOT clear it, and the remedy was a hand-run `mv
 * node_modules/.vite*` aside. The lifecycle script now clears a stale cache
 * before boot; this file proves the verdict flips the right way.
 *
 * The search before creation: `tests/setup/dev-server-freshness.ts` owns the
 * ADJACENT question (a dev server PROCESS older than the last HEAD change),
 * and `dev-server-freshness.test.ts` drives its parsers. That guard judges
 * the SERVER'S AGE; this one judges the CACHE'S AGE against the source it
 * serves — a fresh server on a stale cache still 504s. No existing test names
 * the dep-optimizer cache's freshness, so this is a new owner, not a second
 * door into a neighbour's charter.
 *
 * The live half (the filesystem reads) is thin by design; everything that
 * DECIDES — the walk, the stamp read, the verdict — is pure and driven here
 * over planted fixture trees. The verdict is mutation-verified: a verdict
 * that ignored the source stamp, or one that never refused, turns a planted
 * stale cache green, which the arms below refuse.
 */
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";

import { createTempDir } from "../helpers/temp-dir.ts";
import {
  DEP_CACHE_DIR,
  GRAPH_CONFIG_FILES,
  SERVED_ROOTS,
  depCacheStampMs,
  depCacheStalenessVerdict,
  graphConfigMtimeMs,
  newestSourceMtimeMs,
  staleDepCacheVerdict,
} from "../../scripts/vite-dep-cache.ts";

/**
 * A fixture tree: the served roots and the FULLY-SHAPED cache. Creating the
 * whole shape before any stamp is planted matters — adding an entry to a
 * directory moves that directory's mtime, so a stamp planted before a
 * sibling's creation is silently overwritten by the fixture itself. Every
 * directory the plants below touch is made here, up front.
 */
function plantTree(): string {
  const root = createTempDir("ch-vite-dep-cache-");
  for (const dir of [
    ...SERVED_ROOTS,
    join(DEP_CACHE_DIR, "deps"),
    join(DEP_CACHE_DIR, "deps_ssr"),
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  return root;
}

/**
 * Write a file (creating its parents) and pin its mtime to a fixed instant.
 * Pinning the FILE is not enough: the walk's stamp can come from a DIRECTORY
 * (the optimizer touches the cache root when it writes, and adding an entry
 * moves the parent), so every ancestor directory of the file is re-pinned to
 * the same instant. That makes the planted instant the stamp the walk reads,
 * deterministically.
 */
function plant(path: string, atMs: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "x", "utf8");
  const at = new Date(atMs);
  utimesSync(path, at, at);
}

/** Re-pin every directory from `dir` up to (and including) `stopAt`. */
function pinDirs(dir: string, stopAt: string, atMs: number): void {
  const at = new Date(atMs);
  let cur = dir;
  while (cur.startsWith(stopAt) && cur !== stopAt) {
    utimesSync(cur, at, at);
    cur = dirname(cur);
  }
  utimesSync(stopAt, at, at);
}

/** Re-pin EVERY directory under the cache root to one instant. */
function pinCacheDirs(root: string, atMs: number): void {
  pinDirs(join(root, DEP_CACHE_DIR, "deps"), join(root, DEP_CACHE_DIR), atMs);
  pinDirs(join(root, DEP_CACHE_DIR, "deps_ssr"), join(root, DEP_CACHE_DIR), atMs);
}

const OLD = 1_700_000_000_000; // 2023-11-14
const NEW = 1_760_000_000_000; // 2025-10-12

describe("newestSourceMtimeMs — the served-source stamp", () => {
  test("the newest file across every served root wins", () => {
    const root = plantTree();
    plant(join(root, "src", "a.ts"), OLD);
    plant(join(root, "server", "b.ts"), NEW);
    plant(join(root, "engine", "src", "c.ts"), OLD + 1);
    expect(newestSourceMtimeMs(root, SERVED_ROOTS)).toBe(NEW);
  });

  test("a skipped directory's newer file does NOT move the stamp", () => {
    const root = plantTree();
    plant(join(root, "src", "a.ts"), OLD);
    // A vendored corpus / generated output under a served root is not source
    // the dev server wrote; it must not vote.
    mkdirSync(join(root, "src", "node_modules", "dep"), { recursive: true });
    plant(join(root, "src", "node_modules", "dep", "x.js"), NEW);
    mkdirSync(join(root, "engine", "src", "dist"), { recursive: true });
    plant(join(root, "engine", "src", "dist", "bundle.js"), NEW);
    expect(newestSourceMtimeMs(root, SERVED_ROOTS)).toBe(OLD);
  });

  test("a root that does not exist is simply absent, not an error", () => {
    const root = createTempDir("ch-vite-dep-cache-");
    expect(newestSourceMtimeMs(root, ["no-such-root"])).toBeNull();
  });
});

describe("graphConfigMtimeMs — the module-graph config stamp", () => {
  test("an edited vite.config.ts votes alongside the served trees", () => {
    const root = plantTree();
    plant(join(root, "vite.config.ts"), NEW);
    expect(graphConfigMtimeMs(root, GRAPH_CONFIG_FILES)).toBe(NEW);
  });

  test("a missing config file does not vote and does not error", () => {
    const root = plantTree();
    expect(graphConfigMtimeMs(root, GRAPH_CONFIG_FILES)).toBeNull();
  });
});

describe("depCacheStampMs — the cache's own age", () => {
  test("the newest entry inside the cache is its stamp", () => {
    const root = plantTree();
    const ssrEntry = join(root, DEP_CACHE_DIR, "deps_ssr", "x.js");
    plant(join(root, DEP_CACHE_DIR, "deps", "_metadata.json"), OLD);
    plant(ssrEntry, NEW);
    // Pin the cache's own directories OLD: the newest entry is the file,
    // so the stamp must be the file's, not a directory's creation instant.
    pinDirs(join(root, DEP_CACHE_DIR, "deps"), join(root, DEP_CACHE_DIR), OLD);
    pinDirs(join(root, DEP_CACHE_DIR, "deps_ssr"), join(root, DEP_CACHE_DIR), OLD);
    expect(depCacheStampMs(root)).toBe(NEW);
  });

  test("an absent cache reads as null (absent, never a guess)", () => {
    const root = createTempDir("ch-vite-dep-cache-");
    expect(depCacheStampMs(root)).toBeNull();
  });
});

describe("depCacheStalenessVerdict — the pure comparison", () => {
  test("a cache OLDER than the source is refused", () => {
    const verdict = depCacheStalenessVerdict(NEW, OLD);
    expect(verdict).not.toBeNull();
    expect(verdict).toContain("predates the source");
    expect(verdict).toContain(DEP_CACHE_DIR);
  });

  test("a cache at or NEWER than the source is kept", () => {
    expect(depCacheStalenessVerdict(OLD, NEW)).toBeNull();
    expect(depCacheStalenessVerdict(NEW, NEW)).toBeNull();
  });

  test("an absent cache is kept (the next boot builds one, not clears one)", () => {
    expect(depCacheStalenessVerdict(NEW, null)).toBeNull();
  });

  test("an unreadable source is NOT JUDGED, never a permissive guess", () => {
    expect(depCacheStalenessVerdict(null, OLD)).toBeNull();
  });
});

describe("staleDepCacheVerdict — the wired verdict over a fixture tree", () => {
  test("a source edit newer than the cache flips the verdict to stale", () => {
    const root = plantTree();
    const cacheMarker = join(root, DEP_CACHE_DIR, "deps", "_metadata.json");
    plant(join(root, "src", "a.ts"), OLD);
    plant(join(root, "server", "index.ts"), OLD);
    plant(cacheMarker, NEW); // cache built AFTER the source — fresh
    pinCacheDirs(root, NEW);
    pinDirs(join(root, "src"), join(root, "src"), OLD);
    pinDirs(join(root, "server"), join(root, "server"), OLD);
    expect(staleDepCacheVerdict(root)).toBeNull();
    // The class the fix exists for: an edit under a served root moves the
    // source stamp past the cache's build stamp.
    plant(join(root, "server", "index.ts"), NEW + 1);
    const verdict = staleDepCacheVerdict(root);
    expect(verdict).not.toBeNull();
    expect(verdict).toContain("predates the source");
  });

  test("a config edit (vite.config.ts) also flips the verdict", () => {
    const root = plantTree();
    const cacheMarker = join(root, DEP_CACHE_DIR, "deps", "_metadata.json");
    plant(join(root, "vite.config.ts"), OLD);
    plant(cacheMarker, NEW); // fresh: cache newer than the config
    pinCacheDirs(root, NEW);
    plant(join(root, "vite.config.ts"), NEW + 1); // then the config is edited
    expect(staleDepCacheVerdict(root)).not.toBeNull();
  });

  test("a fresh cache stays fresh", () => {
    const root = plantTree();
    const cacheMarker = join(root, DEP_CACHE_DIR, "deps", "_metadata.json");
    plant(join(root, "src", "a.ts"), OLD);
    pinDirs(join(root, "src"), join(root, "src"), OLD);
    plant(cacheMarker, NEW);
    pinCacheDirs(root, NEW);
    expect(staleDepCacheVerdict(root)).toBeNull();
  });
});
