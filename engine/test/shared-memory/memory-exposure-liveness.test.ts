// test/shared-memory/memory-exposure-liveness.test.ts
// sharedMemory exposure — CUSTOMIZATION LIVENESS. Same standard as
// test/shared/exposure-customization-liveness.test.ts: every rendered
// control must CHANGE BEHAVIOUR. The three sharedMemory customizations
// (retrievalMethod, storageBackend, tokenCapStrategy) previously had no-op
// setters — a rendered control whose `set` changes nothing is a lie about
// capability. Each test here proves MORE than a round-trip: set the knob,
// execute the store's REAL code path (search / enforceCaps / flush+reload),
// observe a different outcome, restore.

import { join } from "node:path";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import {
  createSearchQuery,
  createSharedMemoryStore,
  registerMemoryExposure,
  resolveSharedMemoryConfig,
  verifyEntryIntegrity,
  type SharedMemoryStore,
  type SharedMemoryStoreOptions,
} from "../../src/shared/memory/index.ts";
import type { PartialSharedMemoryConfig } from "../../src/shared/memory/memory-config.ts";
import {
  executeAction,
  getCustomizationValue,
  listActionsByModule,
  listCustomizationsByModule,
  listSignalsByModule,
  readSignal,
  resetCustomizationValue,
  resetExposureForTest,
  setCustomizationValue,
} from "../../src/shared/exposure/index.ts";
import { createTempDir } from "../support/temp-dir.ts";

// Routed through the temp-dir OWNER: the previous hardcoded `/tmp/bridlewise`
// path leaked into the system temp root (its own prevention guard has been
// failing on this file), and a hand-rolled path cannot be cleaned by the
// owner that every other suite uses. `createTempDir` registers its own
// removal, so these files cannot outlive the run.
const tmpRoot = createTempDir("mem-exposure");
const tmp = (n: string) => join(tmpRoot, `${n}.bin`);
const clean = (p: string) => { try { rmSync(p, { force: true }); } catch { /* ignore */ } };

/** Fresh store + fresh registry so each test binds the exposure surface to
 * its own store (the registry is process-global). */
function fresh(config: PartialSharedMemoryConfig, options: Omit<SharedMemoryStoreOptions, "config"> = {}): SharedMemoryStore {
  resetExposureForTest();
  const store = createSharedMemoryStore({
    ...options,
    config: resolveSharedMemoryConfig({ embeddings: { enabled: false }, ...config }),
  });
  registerMemoryExposure(store);
  return store;
}

/** Token-cap scenario: two 100-char (25-token) hot entries against a
 * 45-token hot cap → over cap; target = floor(45*0.6) = 27 keeps exactly
 * one entry for the prune strategies. */
const CAP_CONFIG: PartialSharedMemoryConfig = {
  tokenCap: {
    strategy: "tier",
    hotTokenLimit: 45,
    warmTokenLimit: 10_000,
    coldTokenLimit: 100_000,
    trimTriggerRatio: 0.8,
    compressTargetRatio: 0.6,
  },
};

/** Deterministic strictly-increasing clock (1 min per call). */
function makeClock(): () => string {
  let tick = 0;
  return () => new Date(1_700_000_000_000 + tick++ * 60_000).toISOString();
}

describe("sharedMemory.retrievalMethod drives the live search dispatch", () => {
  test("set → search() → different result set per method → restore", async () => {
    const store = fresh({ retrieval: { method: "hybrid", minScore: 0.01 } });
    try {
      const fact = store.addHot("alpha crash beta report", "fact", "user");
      const error = store.addHot("alpha crash gamma trace", "error", "tool");
      store.addHot("totally unrelated weather clouds", "observation", "user");
      const query = () => store.search(createSearchQuery({ text: "alpha crash", limit: 10 }));

      assert.equal(getCustomizationValue("sharedMemory.retrievalMethod"), "hybrid");

      setCustomizationValue("sharedMemory.retrievalMethod", "tfidf");
      assert.equal(store.config.retrieval.method, "tfidf", "set must reach the store's live config");
      const tfidf = await query();
      assert.deepEqual(tfidf[0]!.matchedFields, ["tfidf"], "search must dispatch on the tfidf path");
      assert.deepEqual(
        tfidf.map((r) => r.entry.id).toSorted(),
        [fact.id, error.id].toSorted(),
        "tfidf scores EVERY keyword-bearing entry regardless of type",
      );

      setCustomizationValue("sharedMemory.retrievalMethod", "tree");
      const tree = await query();
      assert.deepEqual(tree[0]!.matchedFields, ["tree", "error"], "tree classifies the query (crash → error)");
      assert.deepEqual(
        tree.map((r) => r.entry.id),
        [error.id],
        "tree prunes retrieval to the classified subtree — a DIFFERENT outcome than tfidf",
      );

      setCustomizationValue("sharedMemory.retrievalMethod", "inverted");
      const inverted = await query();
      assert.deepEqual(inverted[0]!.matchedFields, ["inverted"], "search must dispatch on the inverted path");

      resetCustomizationValue("sharedMemory.retrievalMethod");
      assert.equal(getCustomizationValue("sharedMemory.retrievalMethod"), "hybrid");
      const hybrid = await query();
      assert.deepEqual(hybrid[0]!.matchedFields, ["hybrid"], "reset restores the default dispatch");
    } finally {
      store.close();
    }
  });
});

describe("sharedMemory.tokenCapStrategy drives what enforceCaps does", () => {
  test("tier (default) demotes the OLDEST overflowing entry", async () => {
    const store = fresh(CAP_CONFIG, { clock: makeClock() });
    try {
      const older = store.addHot("a".repeat(100), "fact", "user");
      const newer = store.addHot("b".repeat(100), "fact", "user");
      assert.equal(getCustomizationValue("sharedMemory.tokenCapStrategy"), "tier");
      await executeAction("sharedMemory.enforceCaps");
      assert.deepEqual(store.byTier("hot").map((e) => e.id), [newer.id], "newest survives in hot");
      assert.deepEqual(store.byTier("warm").map((e) => e.id), [older.id], "oldest is demoted, not dropped");
    } finally {
      store.close();
    }
  });

  test("prune-least-relevant keeps the RETRIEVED entry instead of the newest or the first-inserted", async () => {
    const store = fresh(CAP_CONFIG, { clock: makeClock() });
    try {
      // Three 25-token entries against target 27 → exactly ONE survives in
      // hot. The relevant entry is deliberately NEITHER the newest (which
      // the tier/prune-oldest strategies keep) NOR the first-inserted (which
      // a zero-relevance stable sort keeps), so this proof fails if the
      // strategy is ignored OR if search() stops recording real relevance.
      const firstInserted = store.addHot("weather clouds rain forecast".padEnd(100, "x"), "fact", "user");
      const relevant = store.addHot("parseExpression handles AST nodes".padEnd(100, "y"), "fact", "user");
      const newest = store.addHot("gardening tomato seedling soil".padEnd(100, "z"), "fact", "user");
      // Real retrieval history: only `relevant` matches this query.
      const res = await store.search(createSearchQuery({ text: "parseExpression AST", limit: 5 }));
      assert.deepEqual(res.map((r) => r.entry.id), [relevant.id], "precondition: retrieval hit the relevant entry only");

      setCustomizationValue("sharedMemory.tokenCapStrategy", "prune-least-relevant");
      assert.equal(store.config.tokenCap.strategy, "prune-least-relevant", "set must reach the store's live config");
      await executeAction("sharedMemory.enforceCaps");
      assert.deepEqual(store.byTier("hot").map((e) => e.id), [relevant.id],
        "the RETRIEVED entry survives — a different outcome than tier (keeps newest) or a dead relevance map (keeps first-inserted)");
      assert.deepEqual(store.byTier("warm").map((e) => e.id).toSorted(), [firstInserted.id, newest.id].toSorted());
      resetCustomizationValue("sharedMemory.tokenCapStrategy");
    } finally {
      store.close();
    }
  });

  test("compress shrinks entries IN PLACE (no demotion) with intact integrity digests", async () => {
    const store = fresh(CAP_CONFIG, { clock: makeClock() });
    try {
      store.addHot("c".repeat(100), "fact", "user");
      store.addHot("d".repeat(100), "fact", "user");
      setCustomizationValue("sharedMemory.tokenCapStrategy", "compress");
      await executeAction("sharedMemory.enforceCaps");
      const hot = store.byTier("hot");
      assert.equal(hot.length, 2, "compress keeps every entry in its tier");
      assert.equal(store.byTier("warm").length, 0, "nothing is demoted");
      for (const entry of hot) {
        assert.equal(entry.content.length, 60, "content shrunk to compressTargetRatio (0.6 * 100 chars)");
        assert.equal(entry.tokenEstimate, 15, "tokenEstimate recomputed for the compressed content");
        assert.equal(verifyEntryIntegrity(entry), true, "digest recomputed — compressed entries are not corruption");
      }
      assert.equal(store.stats().totalTokens, 30, "tokens actually reduced by compression");
      resetCustomizationValue("sharedMemory.tokenCapStrategy");
      assert.equal(getCustomizationValue("sharedMemory.tokenCapStrategy"), "tier");
    } finally {
      store.close();
    }
  });
});

describe("sharedMemory.storageBackend swaps the live persistence port", () => {
  test("set → flush/append/reload run against the NEW backend → restore", async () => {
    const path = tmp("backend-switch");
    const store = fresh({ storage: { backend: "json", coldPath: path, flushIntervalMs: 5_000 } });
    try {
      store.addHot("first entry content", "fact", "user");
      store.addHot("second entry content", "fact", "user");
      await executeAction("sharedMemory.flush");
      assert.ok(Array.isArray(JSON.parse(readFileSync(path, "utf8"))), "json backend persists ONE JSON array snapshot");
      assert.equal(getCustomizationValue("sharedMemory.storageBackend"), "json");

      // json backend: per-entry append is a snapshot-only no-op.
      const jsonOps = store.stats().storageOps;
      store.addHot("json append is a no-op", "fact", "user");
      assert.equal(store.stats().storageOps, jsonOps, "json backend ignores per-entry append");

      setCustomizationValue("sharedMemory.storageBackend", "append-log");
      assert.equal(store.config.storage.backend, "append-log", "set must reach the store's live config");
      const logText = readFileSync(path, "utf8");
      assert.equal(logText.trimEnd().split("\n").length, 3, "swap re-persists the FULL snapshot in the new format");
      assert.throws(() => JSON.parse(logText), "NDJSON snapshot is not one JSON document — the format really changed");

      // append-log backend: per-entry append hits disk immediately.
      const logOps = store.stats().storageOps;
      store.addHot("append-log appends immediately", "fact", "user");
      assert.equal(store.stats().storageOps, logOps + 1, "append-log backend performs a REAL append per add");

      await executeAction("sharedMemory.reload");
      assert.equal(store.all().length, 4, "reload reconstructs every entry from the new backend");
      assert.equal(Number(readSignal("sharedMemory.corruptedDropped")), 0, "no entry surfaced as corruption after the swap");

      setCustomizationValue("sharedMemory.storageBackend", "json");
      assert.ok(Array.isArray(JSON.parse(readFileSync(path, "utf8"))), "restoring re-persists the json snapshot");
    } finally {
      store.close();
      clean(path);
    }
  });
});

// ---------------------------------------------------------------------------
// The fresh probe: nothing inert remains on the sharedMemory exposure surface
// ---------------------------------------------------------------------------

describe("fresh probe: sharedMemory exposure surface", () => {
  test("every customization round-trips through set/current", () => {
    const path = tmp("roundtrip");
    const store = fresh({ storage: { backend: "json", coldPath: path, flushIntervalMs: 5_000 } });
    try {
      const customizations = listCustomizationsByModule("sharedMemory");
      assert.ok(customizations.length > 0, "surface must not be empty");
      for (const customization of customizations) {
        const original = customization.current();
        const alternative = (customization.enum ?? []).find((v) => v !== original);
        assert.ok(alternative !== undefined, `${customization.id}: contract admits no second legal value`);
        setCustomizationValue(customization.id, alternative);
        assert.equal(customization.current(), alternative, `${customization.id}: set must be observable via current()`);
        setCustomizationValue(customization.id, original as string);
        assert.equal(customization.current(), original, `${customization.id}: restore must round-trip too`);
      }
    } finally {
      store.close();
      clean(path);
    }
  });

  test("every signal reads live store state (totalCount reacts to a write)", () => {
    const store = fresh({});
    try {
      for (const signal of listSignalsByModule("sharedMemory")) {
        void readSignal(signal.id); // must not throw — every gauge reads real stats
      }
      const before = Number(readSignal("sharedMemory.totalCount"));
      store.addHot("liveness write", "fact", "user");
      assert.equal(Number(readSignal("sharedMemory.totalCount")), before + 1, "signals reflect store mutations");
      assert.equal(Number(readSignal("sharedMemory.hotTokens")) > 0, true, "token gauges read live tier state");
    } finally {
      store.close();
    }
  });

  test("surface counts are honest: 14 signals, 3 actions, 3 customizations", () => {
    const store = fresh({});
    try {
      assert.equal(listSignalsByModule("sharedMemory").length, 14);
      assert.equal(listActionsByModule("sharedMemory").length, 3);
      assert.equal(listCustomizationsByModule("sharedMemory").length, 3);
    } finally {
      store.close();
    }
  });

  test("no no-op setters or constant current() literals remain in memory-exposure.ts", () => {
    const source = readFileSync(new URL("../../src/shared/memory/memory-exposure.ts", import.meta.url), "utf8");
    assert.ok(!/set:\s*\(\)\s*=>\s*\{/.test(source), "memory-exposure.ts still contains a no-op setter");
    assert.ok(!/current:\s*\(\)\s*=>\s*(\d|true\b|false\b|")/.test(source), "memory-exposure.ts still contains a constant current()");
  });
});
