import assert from "node:assert/strict";
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createMemoryStore, computeMemoryEntryHash, type MemoryStore } from "../../src/memory/memory-store.ts";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import {
  resolveMemoryConfig,
  type MemoryEntry,
  type MemoryTier,
} from "../../src/memory/memory-types.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { mkTempDir } from "../support/temp-dir.ts";

function mkStore(dir: string, config?: Parameters<typeof createMemoryStore>[0]["config"]): MemoryStore {
  const timelineStore = createTimelineStore({
    path: join(dir, `memory-${Date.now()}-${Math.random().toString(36).slice(2)}.db`),
  });
  return createMemoryStore({ store: timelineStore, ...(config !== undefined ? { config } : {}) });
}

// ========== Basic creation and config ==========

test("memory-store: creates store with default config", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    assert.equal(store.count(), 0);
    assert.equal(store.config.contextTokenLimit, resolveMemoryConfig().contextTokenLimit);
    assert.equal(store.config.trimThreshold, resolveMemoryConfig().trimThreshold);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: creates store with custom config", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir, { contextTokenLimit: 8192, trimThreshold: 0.7, recentTurnWindow: 5 });
    assert.equal(store.config.contextTokenLimit, 8192);
    assert.equal(store.config.trimThreshold, 0.7);
    assert.equal(store.config.recentTurnWindow, 5);
    assert.equal(store.config.shortTermTurnLimit, resolveMemoryConfig().shortTermTurnLimit);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== FIX-4: createMemoryStore enforces canonical validation ==========

test("memory-store: createMemoryStore enforces the same validation as resolveMemoryConfig (FIX-4)", () => {
  // The local resolveConfig previously SKIPPED validation
  // (contextTokenLimit/trimThreshold/recentTurnWindow checks). After the fix,
  // createMemoryStore delegates to resolveMemoryConfig, which enforces all
  // bounds. Each invalid input that resolveMemoryConfig rejects must also be
  // rejected by createMemoryStore.
  const dir = mkTempDir("memory-test-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "test.db"), ledgerId: "l1" });
    // contextTokenLimit < 1
    assert.throws(
      () => createMemoryStore({ store: timelineStore, config: { contextTokenLimit: 0 } }),
      /contextTokenLimit must be a positive finite number/u,
    );
    // trimThreshold out of range [0.5, 0.99]
    assert.throws(
      () => createMemoryStore({ store: timelineStore, config: { trimThreshold: 0.1 } }),
      /trimThreshold must be between 0.5 and 0.99/u,
    );
    // recentTurnWindow < 1
    assert.throws(
      () => createMemoryStore({ store: timelineStore, config: { recentTurnWindow: 0 } }),
      /recentTurnWindow must be a positive finite number/u,
    );
    // shortTermTurnLimit < 1
    assert.throws(
      () => createMemoryStore({ store: timelineStore, config: { shortTermTurnLimit: 0 } }),
      /shortTermTurnLimit must be a positive finite number/u,
    );
    // longTermFactLimit < 1
    assert.throws(
      () => createMemoryStore({ store: timelineStore, config: { longTermFactLimit: 0 } }),
      /longTermFactLimit must be a positive finite number/u,
    );
    // searchResultLimit < 1
    assert.throws(
      () => createMemoryStore({ store: timelineStore, config: { searchResultLimit: 0 } }),
      /searchResultLimit must be a positive finite number/u,
    );
    // summaryMaxTokens < 1
    assert.throws(
      () => createMemoryStore({ store: timelineStore, config: { summaryMaxTokens: 0 } }),
      /summaryMaxTokens must be a positive finite number/u,
    );
    // contentMaxCharacters < 1
    assert.throws(
      () => createMemoryStore({ store: timelineStore, config: { contentMaxCharacters: 0 } }),
      /contentMaxCharacters must be a positive finite number/u,
    );
    // maxTagsPerEntry < 1
    assert.throws(
      () => createMemoryStore({ store: timelineStore, config: { maxTagsPerEntry: 0 } }),
      /maxTagsPerEntry must be a positive finite number/u,
    );
    // maxTopicCharacters < 1
    assert.throws(
      () => createMemoryStore({ store: timelineStore, config: { maxTopicCharacters: 0 } }),
      /maxTopicCharacters must be a positive finite number/u,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: createMemoryStore throws InputError (typed) for invalid config (FIX-4)", () => {
  // The canonical resolveMemoryConfig throws InputError (after FIX-5), so
  // createMemoryStore must propagate the typed error, not a generic Error.
  const dir = mkTempDir("memory-test-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "test.db"), ledgerId: "l1" });
    let caught: unknown;
    try {
      createMemoryStore({ store: timelineStore, config: { contextTokenLimit: -5 } });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error, "must throw");
    // After FIX-5, resolveMemoryConfig throws InputError. Verify the typed
    // error name and code so callers can distinguish error types.
    const err = caught as { name?: string; code?: string };
    assert.equal(err.name, "InputError", "must be an InputError instance");
    assert.equal(err.code, "memory_config_invalid", "must have the memory_config_invalid code");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: ledgerId matches timeline store", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const timelineStore = createTimelineStore({
      path: join(dir, "test.db"),
      ledgerId: "test-ledger",
    });
    const store = createMemoryStore({ store: timelineStore });
    assert.equal(store.ledgerId, "test-ledger");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Present memory ==========

test("memory-store: addPresent creates present entry", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    const entry = store.addPresent("current context");
    assert.equal(entry.tier, "present");
    assert.equal(entry.content, "current context");
    assert.equal(store.count(), 1);
    assert.equal(store.countByTier("present"), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: present entries are not persisted to timeline", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "test.db"), ledgerId: "l1" });
    const store = createMemoryStore({ store: timelineStore });
    store.addPresent("ephemeral");
    store.reload();
    assert.equal(store.count(), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: present entries have unique IDs", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    const e1 = store.addPresent("first");
    const e2 = store.addPresent("second");
    assert.notEqual(e1.id, e2.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: clearPresent removes all present entries", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    store.addPresent("a");
    store.addPresent("b");
    assert.equal(store.countByTier("present"), 2);
    store.clearPresent();
    assert.equal(store.countByTier("present"), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Short-term memory ==========

test("memory-store: addShortTerm creates short-term entry", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    const entry = store.addShortTerm("recent turn");
    assert.equal(entry.tier, "short-term");
    assert.equal(store.countByTier("short-term"), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: short-term entries persist to timeline and survive reload", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "test.db"), ledgerId: "l1" });
    const store = createMemoryStore({ store: timelineStore });
    store.addShortTerm("persistent memory");
    store.reload();
    assert.equal(store.countByTier("short-term"), 1);
    const entries = store.shortTerm();
    assert.equal(entries[0]!.content, "persistent memory");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: short-term entries with tags persist", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "test.db"), ledgerId: "l1" });
    const store = createMemoryStore({ store: timelineStore });
    store.addShortTerm("tagged memory", { tags: ["bug", "critical"] });
    store.reload();
    const entries = store.shortTerm();
    assert.deepEqual([...entries[0]!.tags], ["bug", "critical"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: short-term entries with agentId persist", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "test.db"), ledgerId: "l1" });
    const store = createMemoryStore({ store: timelineStore });
    store.addShortTerm("agent memory", { agentId: "agent-1" });
    store.reload();
    const entries = store.shortTerm();
    assert.equal(entries[0]!.agentId, "agent-1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: short-term entries with topic persist", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "test.db"), ledgerId: "l1" });
    const store = createMemoryStore({ store: timelineStore });
    store.addShortTerm("topic memory", { topic: "security" });
    store.reload();
    const entries = store.shortTerm();
    assert.equal(entries[0]!.topic, "security");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: short-term entry limit enforced", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir, { shortTermTurnLimit: 3 });
    store.addShortTerm("entry 1");
    store.addShortTerm("entry 2");
    store.addShortTerm("entry 3");
    store.addShortTerm("entry 4");
    assert.equal(store.countByTier("short-term"), 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Long-term memory ==========

test("memory-store: addLongTerm creates long-term entry", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    const entry = store.addLongTerm("important fact");
    assert.equal(entry.tier, "long-term");
    assert.equal(store.countByTier("long-term"), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: long-term entries persist to timeline and survive reload", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "test.db"), ledgerId: "l1" });
    const store = createMemoryStore({ store: timelineStore });
    store.addLongTerm("durable fact");
    store.reload();
    assert.equal(store.countByTier("long-term"), 1);
    assert.equal(store.longTerm()[0]!.content, "durable fact");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: long-term entry limit enforced", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir, { longTermFactLimit: 2 });
    store.addLongTerm("fact 1");
    store.addLongTerm("fact 2");
    store.addLongTerm("fact 3");
    assert.equal(store.countByTier("long-term"), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Promotion ==========

test("memory-store: promotePresent moves present entries to short-term", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    store.addPresent("to promote");
    assert.equal(store.countByTier("present"), 1);
    const promoted = store.promotePresent();
    assert.equal(promoted.length, 1);
    assert.equal(promoted[0]!.tier, "short-term");
    assert.equal(store.countByTier("present"), 0);
    assert.equal(store.countByTier("short-term"), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: promotePresent persists promoted entries to timeline", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "test.db"), ledgerId: "l1" });
    const store = createMemoryStore({ store: timelineStore });
    store.addPresent("to promote");
    store.promotePresent();
    store.reload();
    assert.equal(store.countByTier("short-term"), 1);
    assert.equal(store.countByTier("present"), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: promotePresent with no entries returns empty", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    const promoted = store.promotePresent();
    assert.equal(promoted.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: promoteToLongTerm creates long-term entry from short-term", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    const entry = store.addShortTerm("to promote to long-term");
    const longTerm = store.promoteToLongTerm(entry.id, "summarized fact");
    assert.ok(longTerm !== null);
    assert.equal(longTerm!.tier, "long-term");
    assert.equal(longTerm!.content, "summarized fact");
    assert.ok([...longTerm!.tags].includes("promoted"));
    assert.equal(store.countByTier("short-term"), 0);
    assert.equal(store.countByTier("long-term"), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: promoteToLongTerm persists to timeline", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "test.db"), ledgerId: "l1" });
    const store = createMemoryStore({ store: timelineStore });
    const entry = store.addShortTerm("temp");
    store.promoteToLongTerm(entry.id, "permanent fact");
    store.reload();
    assert.equal(store.countByTier("long-term"), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: promoteToLongTerm with non-existent ID returns null", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    assert.equal(store.promoteToLongTerm("nonexistent", "summary"), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: demoteToShortTerm moves long-term to short-term", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    const entry = store.addLongTerm("demote me");
    const demoted = store.demoteToShortTerm(entry.id);
    assert.ok(demoted !== null);
    assert.equal(demoted!.tier, "short-term");
    assert.equal(store.countByTier("long-term"), 0);
    assert.equal(store.countByTier("short-term"), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Get and query ==========

test("memory-store: get retrieves entry by ID", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    const entry = store.addShortTerm("findable");
    assert.equal(store.get(entry.id)!.content, "findable");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: get returns null for non-existent ID", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    assert.equal(store.get("nonexistent"), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: all returns entries from all tiers", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    store.addPresent("present");
    store.addShortTerm("short");
    store.addLongTerm("long");
    assert.equal(store.all().length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: present/shortTerm/longTerm return tier-specific entries", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    store.addPresent("p1");
    store.addPresent("p2");
    store.addShortTerm("s1");
    store.addLongTerm("l1");
    assert.equal(store.present().length, 2);
    assert.equal(store.shortTerm().length, 1);
    assert.equal(store.longTerm().length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Search ==========

test("memory-store: searchByText finds matching entries", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    store.addShortTerm("error in file writer");
    store.addShortTerm("success in build");
    const results = store.searchByText("error");
    assert.equal(results.length, 1);
    assert.ok(results[0]!.entry.content.includes("error"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: searchByAgent filters by agent", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    store.addShortTerm("a1 content", { agentId: "a1" });
    store.addShortTerm("a2 content", { agentId: "a2" });
    const results = store.searchByAgent("a1");
    assert.equal(results.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: searchByTopic filters by topic", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    store.addShortTerm("security issue", { topic: "security" });
    store.addShortTerm("perf issue", { topic: "performance" });
    const results = store.searchByTopic("security");
    assert.equal(results.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: searchByTimeRange filters by timestamp", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    store.addShortTerm("old", { timestamp: "2026-07-16T00:00:00.000Z" });
    store.addShortTerm("new", { timestamp: "2026-07-16T12:00:00.000Z" });
    const results = store.searchByTimeRange("2026-07-16T06:00:00.000Z", "2026-07-16T23:59:59.000Z");
    assert.equal(results.length, 1);
    assert.ok(results[0]!.entry.content.includes("new"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: searchByTags filters by tags", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    store.addShortTerm("tagged", { tags: ["bug", "critical"] });
    store.addShortTerm("untagged");
    const results = store.searchByTags(["bug", "critical"]);
    assert.equal(results.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: searchByTier filters by tier", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    store.addShortTerm("short");
    store.addLongTerm("long");
    const results = store.searchByTier("long-term");
    assert.equal(results.length, 1);
    assert.equal(results[0]!.entry.tier, "long-term");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Token estimation ==========

test("memory-store: estimateTotalTokens sums content tokens", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    store.addShortTerm("a".repeat(40));
    store.addLongTerm("b".repeat(80));
    const tokens = store.estimateTotalTokens();
    assert.ok(tokens > 0);
    assert.equal(tokens, Math.ceil(40 / 4) + Math.ceil(80 / 4));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: estimateTotalTokens is zero for empty store", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    assert.equal(store.estimateTotalTokens(), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Validation ==========

test("memory-store: rejects empty content", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    assert.throws(() => store.addPresent(""), /empty/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: rejects oversized content", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir, { contentMaxCharacters: 10 });
    assert.throws(() => store.addPresent("x".repeat(11)), /exceeds/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: rejects too many tags", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir, { maxTagsPerEntry: 3 });
    assert.throws(() => store.addShortTerm("x", { tags: ["a", "b", "c", "d"] }), /exceeding/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: rejects oversized topic", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir, { maxTopicCharacters: 5 });
    assert.throws(() => store.addShortTerm("x", { topic: "too long topic" }), /exceeds/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: rejects invalid tier", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    assert.throws(() => store.add({ tier: "invalid" as MemoryTier, content: "x" }), InputError);
    assert.throws(() => store.add({ tier: "invalid" as MemoryTier, content: "x" }), /Invalid memory tier/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Config resolution ==========

test("memory-store: resolveMemoryConfig validates contextTokenLimit", () => {
  assert.throws(() => resolveMemoryConfig({ contextTokenLimit: 0 }), InputError);
  assert.throws(() => resolveMemoryConfig({ contextTokenLimit: -1 }), InputError);
  assert.throws(() => resolveMemoryConfig({ contextTokenLimit: NaN }), InputError);
  assert.throws(() => resolveMemoryConfig({ contextTokenLimit: Infinity }), InputError);
});

test("memory-store: resolveMemoryConfig validates trimThreshold range", () => {
  assert.throws(() => resolveMemoryConfig({ trimThreshold: 0.4 }), InputError);
  assert.throws(() => resolveMemoryConfig({ trimThreshold: 1.0 }), InputError);
  assert.throws(() => resolveMemoryConfig({ trimThreshold: NaN }), InputError);
  assert.ok(resolveMemoryConfig({ trimThreshold: 0.5 }));
  assert.ok(resolveMemoryConfig({ trimThreshold: 0.99 }));
});

test("memory-store: resolveMemoryConfig validates all numeric fields", () => {
  assert.throws(() => resolveMemoryConfig({ recentTurnWindow: 0 }), InputError);
  assert.throws(() => resolveMemoryConfig({ shortTermTurnLimit: 0 }), InputError);
  assert.throws(() => resolveMemoryConfig({ longTermFactLimit: 0 }), InputError);
  assert.throws(() => resolveMemoryConfig({ searchResultLimit: 0 }), InputError);
  assert.throws(() => resolveMemoryConfig({ summaryMaxTokens: 0 }), InputError);
  assert.throws(() => resolveMemoryConfig({ contentMaxCharacters: 0 }), InputError);
  assert.throws(() => resolveMemoryConfig({ maxTagsPerEntry: 0 }), InputError);
  assert.throws(() => resolveMemoryConfig({ maxTopicCharacters: 0 }), InputError);
});

test("memory-store: resolveMemoryConfig returns frozen config", () => {
  const config = resolveMemoryConfig({});
  assert.ok(Object.isFrozen(config));
});

// ========== Multiple store instances share timeline ==========

test("memory-store: two stores on same timeline see same short-term entries", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "shared.db"), ledgerId: "l1" });
    const store1 = createMemoryStore({ store: timelineStore });
    store1.addShortTerm("shared entry");
    const store2 = createMemoryStore({ store: timelineStore });
    assert.equal(store2.countByTier("short-term"), 1);
    assert.equal(store2.shortTerm()[0]!.content, "shared entry");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Metadata persistence ==========

test("memory-store: metadata persists across reload", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "test.db"), ledgerId: "l1" });
    const store = createMemoryStore({ store: timelineStore });
    store.addShortTerm("with metadata", { metadata: { key: "value", num: "42" } });
    store.reload();
    const entries = store.shortTerm();
    assert.equal(entries[0]!.metadata["key"], "value");
    assert.equal(entries[0]!.metadata["num"], "42");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Malformed data handling ==========

test("memory-store: reconstructs entry with null agentId", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "test.db"), ledgerId: "l1" });
    const store = createMemoryStore({ store: timelineStore });
    store.addShortTerm("no agent");
    store.reload();
    assert.equal(store.shortTerm()[0]!.agentId, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: reconstructs entry with null topic", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "test.db"), ledgerId: "l1" });
    const store = createMemoryStore({ store: timelineStore });
    store.addShortTerm("no topic");
    store.reload();
    assert.equal(store.shortTerm()[0]!.topic, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: handles unicode content persistence", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "test.db"), ledgerId: "l1" });
    const store = createMemoryStore({ store: timelineStore });
    store.addShortTerm("résumé café naïve 日本語");
    store.reload();
    assert.equal(store.shortTerm()[0]!.content, "résumé café naïve 日本語");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: handles content with special characters", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "test.db"), ledgerId: "l1" });
    const store = createMemoryStore({ store: timelineStore });
    const content = 'special "quotes" and {brackets} and <tags> and \\backslash';
    store.addShortTerm(content);
    store.reload();
    assert.equal(store.shortTerm()[0]!.content, content);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: handles newlines in content", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "test.db"), ledgerId: "l1" });
    const store = createMemoryStore({ store: timelineStore });
    store.addShortTerm("line1\nline2\nline3");
    store.reload();
    assert.equal(store.shortTerm()[0]!.content, "line1\nline2\nline3");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: promoteToLongTerm from present entry", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    const entry = store.addPresent("present to promote");
    const longTerm = store.promoteToLongTerm(entry.id, "summarized");
    assert.ok(longTerm !== null);
    assert.equal(longTerm!.tier, "long-term");
    assert.equal(store.countByTier("present"), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: promoteToLongTerm with empty summary throws", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    const entry = store.addShortTerm("original");
    assert.throws(() => store.promoteToLongTerm(entry.id, ""), /empty/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: demoteToShortTerm with non-existent ID returns null", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    assert.equal(store.demoteToShortTerm("nonexistent"), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: promoted entry metadata contains promotedFrom", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    const entry = store.addShortTerm("original");
    const longTerm = store.promoteToLongTerm(entry.id, "summary");
    assert.equal(longTerm!.metadata["promotedFrom"], entry.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: count returns total across all tiers", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    store.addPresent("p");
    store.addShortTerm("s");
    store.addLongTerm("l");
    assert.equal(store.count(), 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory-store: add with all optional fields", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    const entry = store.add({
      tier: "short-term",
      content: "full entry",
      tags: ["a", "b"],
      agentId: "agent-1",
      topic: "topic-1",
      turnId: "turn-1",
      runId: "run-1",
      timestamp: "2026-07-16T00:00:00.000Z",
      metadata: { key: "value" },
    });
    assert.equal(entry.content, "full entry");
    assert.deepEqual([...entry.tags], ["a", "b"]);
    assert.equal(entry.agentId, "agent-1");
    assert.equal(entry.topic, "topic-1");
    assert.equal(entry.turnId, "turn-1");
    assert.equal(entry.runId, "run-1");
    assert.equal(entry.timestamp, "2026-07-16T00:00:00.000Z");
    assert.equal(entry.metadata["key"], "value");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== BUG-1 (DUP-10): canonical hashing regression ==========

test("memory-store: computeMemoryEntryHash is key-order-independent (canonical hashing)", () => {
  const dir = mkTempDir("memory-test-");
  try {
    const store = mkStore(dir);
    const entry = store.add({
      tier: "short-term",
      content: "canonical hash test",
      tags: ["a"],
      agentId: "agent-1",
      topic: "topic-1",
      timestamp: "2026-07-16T00:00:00.000Z",
      metadata: { key: "value" },
    });
    // Reconstruct the same entry with reversed key order. canonicalHash sorts
    // keys so the hash is identical; the old sha256(JSON.stringify(entry))
    // would have produced a different hash for different key order (DUP-10).
    const reversed: MemoryEntry = {
      metadata: entry.metadata,
      runId: entry.runId,
      turnId: entry.turnId,
      sourceEventId: entry.sourceEventId,
      timestamp: entry.timestamp,
      topic: entry.topic,
      agentId: entry.agentId,
      tags: entry.tags,
      content: entry.content,
      tier: entry.tier,
      id: entry.id,
    };
    assert.equal(computeMemoryEntryHash(entry), computeMemoryEntryHash(reversed));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("BUG-1 prevention: no sha256(JSON.stringify( in canonical-hash owners (DUP-10)", () => {
  const files = [
    "src/memory/memory-store.ts",
    "src/extensions/extension-manifest.ts",
    "src/extensions/extension-lifecycle.ts",
    "src/memory/attempt-history.ts",
  ];
  const re = /sha256\s*\(\s*JSON\.stringify/u;
  for (const rel of files) {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    assert.equal(
      re.test(src),
      false,
      `${rel} must not use sha256(JSON.stringify(...)) — use canonicalHash(...) for identity/fingerprint hashes (DUP-10)`,
    );
  }
});
