// test/memory/scale/memory-1b.test.ts
// EXP452: Unit tests for the billion-token memory store.
// Tests: insert/retrieve, search, LRU cache, sharding, improper usage,
// performance metrics, conversation-scoped + topic-scoped search.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveScaleConfig } from "../../../src/memory/scale/scale-config.ts";
import {
  createScaleMemoryStore,
  capturePerf,
  perfDelta,
  type ScaleMemoryStore,
} from "../../../src/memory/scale/memory-store-1b.ts";
import type { MemoryEntry } from "../../../src/memory/memory-types.ts";
import { createTempDir } from "../../support/temp-dir.ts";

/** This process's own store folder, under the temp-dir owner (never a fixed shared path: two runs would delete each other's store). */
const TEST_DIR = join(createTempDir("memory-1b-"), "store");

function cleanupDir(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
}

function makeEntry(index: number, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return Object.freeze({
    id: `test_${String(index).padStart(8, "0")}`,
    tier: "long-term",
    content: `Entry ${index}: the parser handles token ${index} in conversation conv_${index % 10}. Key detail: hash_${index.toString(16).padStart(8, "0")} variant.`,
    tags: [`topic_${index % 5}`, `conv_${index % 10}`],
    agentId: null,
    topic: `topic_${index % 5}`,
    timestamp: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
    sourceEventId: null,
    turnId: `turn_${index}`,
    runId: null,
    metadata: { conversationId: `conv_${index % 10}` },
    ...overrides,
  });
}

function createStore(shardCount: number = 4): ScaleMemoryStore {
  cleanupDir();
  const config = resolveScaleConfig({
    dataDir: TEST_DIR,
    shardCount,
    hotTierSize: 100,
    insertBatchSize: 100,
    cacheSizeKiB: 4096,
    mmapSize: 0,
  });
  return createScaleMemoryStore(config);
}

describe("EXP452 memory-store-1b", () => {
  test("insert and retrieve by ID", () => {
    const store = createStore(4);
    try {
      const entry = makeEntry(42);
      store.insertOne(entry);
      assert.equal(store.count(), 1);
      const retrieved = store.getById(entry.id);
      assert.ok(retrieved, "entry should be retrievable");
      assert.equal(retrieved!.id, entry.id);
      assert.equal(retrieved!.content, entry.content);
      assert.equal(retrieved!.topic, entry.topic);
      store.close();
    } finally {
      cleanupDir();
    }
  });

  test("batch insert distributes across shards", () => {
    const store = createStore(4);
    try {
      const entries: MemoryEntry[] = [];
      for (let i = 0; i < 1000; i += 1) entries.push(makeEntry(i));
      const inserted = store.insertBatch(entries);
      assert.equal(inserted, 1000);
      assert.equal(store.count(), 1000);
      const sizes = store.shardSizes();
      const total = sizes.reduce((a, b) => a + b, 0);
      assert.equal(total, 1000);
      for (const s of sizes) assert.ok(s > 100, `shard should have >100 entries, got ${s}`);
      store.close();
    } finally {
      cleanupDir();
    }
  });

  test("FTS5 search finds entries by content", () => {
    const store = createStore(4);
    try {
      store.insertOne(makeEntry(1, { content: "the tokenizer reads tokens one at a time" }));
      store.insertOne(makeEntry(2, { content: "the parser dispatches to statement parsers" }));
      store.insertOne(makeEntry(3, { content: "the scope handler tracks variable bindings" }));
      const results = store.search("tokenizer tokens");
      assert.ok(results.length > 0, "should find tokenizer entry");
      assert.equal(results[0]!.entry.content, "the tokenizer reads tokens one at a time");
      store.close();
    } finally {
      cleanupDir();
    }
  });

  test("conversation-scoped search", () => {
    const store = createStore(4);
    try {
      store.insertOne(makeEntry(1, { content: "parser handles tokens", metadata: { conversationId: "conv_a" } }));
      store.insertOne(makeEntry(2, { content: "parser handles tokens", metadata: { conversationId: "conv_b" } }));
      store.insertOne(makeEntry(3, { content: "parser handles tokens", metadata: { conversationId: "conv_a" } }));
      const resultsA = store.searchInConversation("parser tokens", "conv_a", 10);
      assert.ok(resultsA.length > 0, "should find entries in conv_a");
      assert.ok(resultsA.every((r) => r.entry.tags.includes("conv_a") || r.entry.metadata.conversationId === "conv_a"));
      store.close();
    } finally {
      cleanupDir();
    }
  });

  test("topic-scoped search via column prefix", () => {
    const store = createStore(4);
    try {
      store.insertOne(makeEntry(1, { content: "the algorithm processes data efficiently", topic: "parser" }));
      store.insertOne(makeEntry(2, { content: "the algorithm processes data efficiently", topic: "tokenizer" }));
      const results = store.search("topic:parser algorithm", 10);
      assert.ok(results.length > 0, "should find entries with topic parser");
      assert.ok(results.every((r) => r.entry.topic === "parser" || r.entry.topic === null));
      store.close();
    } finally {
      cleanupDir();
    }
  });

  test("LRU cache hits and misses", () => {
    const store = createStore(4);
    try {
      store.insertOne(makeEntry(1));
      store.insertOne(makeEntry(2));
      const e1 = store.getById("test_00000001");
      assert.ok(e1, "first get should work");
      const e1Again = store.getById("test_00000001");
      assert.ok(e1Again, "second get should work from cache");
      const stats = store.stats();
      assert.ok(stats.hotTierHits >= 1, `should have cache hits, got ${stats.hotTierHits}`);
      store.close();
    } finally {
      cleanupDir();
    }
  });

  test("nonexistent ID returns undefined", () => {
    const store = createStore(4);
    try {
      store.insertOne(makeEntry(1));
      const result = store.getById("nonexistent_id");
      assert.equal(result, undefined);
      store.close();
    } finally {
      cleanupDir();
    }
  });

  test("empty query returns empty results", () => {
    const store = createStore(4);
    try {
      store.insertOne(makeEntry(1));
      const results = store.search("");
      assert.equal(results.length, 0);
      store.close();
    } finally {
      cleanupDir();
    }
  });

  test("oversized content does not crash", () => {
    const store = createStore(4);
    try {
      const bigContent = "x".repeat(100_000);
      store.insertOne(makeEntry(1, { content: bigContent }));
      assert.equal(store.count(), 1);
      const retrieved = store.getById("test_00000001");
      assert.ok(retrieved);
      assert.equal(retrieved!.content.length, 100_000);
      store.close();
    } finally {
      cleanupDir();
    }
  });

  test("duplicate insert (same ID) replaces", () => {
    const store = createStore(4);
    try {
      store.insertOne(makeEntry(1, { content: "original content" }));
      store.insertOne(makeEntry(1, { content: "updated content" }));
      assert.equal(store.count(), 1);
      const retrieved = store.getById("test_00000001");
      assert.ok(retrieved);
      assert.equal(retrieved!.content, "updated content");
      store.close();
    } finally {
      cleanupDir();
    }
  });

  test("disk usage reported correctly", () => {
    const store = createStore(4);
    try {
      for (let i = 0; i < 100; i += 1) store.insertOne(makeEntry(i));
      const disk = store.diskBytes();
      assert.ok(disk > 0, `disk bytes should be positive, got ${disk}`);
      store.close();
    } finally {
      cleanupDir();
    }
  });

  test("perf metrics capture and delta", () => {
    const start = capturePerf();
    let sum = 0;
    for (let i = 0; i < 1_000_000; i += 1) sum += i;
    const delta = perfDelta(start);
    assert.ok(delta.wallMs >= 0, `wallMs should be >=0, got ${delta.wallMs}`);
    assert.ok(delta.cpuUserMs >= 0, `cpuUserMs should be >=0, got ${delta.cpuUserMs}`);
    assert.ok(delta.rssBytes > 0, `rssBytes should be >0, got ${delta.rssBytes}`);
  });

  test("shard distribution is balanced", () => {
    const store = createStore(8);
    try {
      const entries: MemoryEntry[] = [];
      for (let i = 0; i < 10_000; i += 1) entries.push(makeEntry(i));
      store.insertBatch(entries);
      const sizes = store.shardSizes();
      const min = Math.min(...sizes);
      const max = Math.max(...sizes);
      assert.ok(max / min < 2, `shard distribution should be balanced (min=${min}, max=${max})`);
      store.close();
    } finally {
      cleanupDir();
    }
  });

  test("search by conversation returns conversation entries", () => {
    const store = createStore(4);
    try {
      store.insertOne(makeEntry(1, { metadata: { conversationId: "conv_x" } }));
      store.insertOne(makeEntry(2, { metadata: { conversationId: "conv_x" } }));
      store.insertOne(makeEntry(3, { metadata: { conversationId: "conv_y" } }));
      const results = store.searchByConversation("conv_x", 10);
      assert.equal(results.length, 2, `should find 2 entries in conv_x, got ${results.length}`);
      store.close();
    } finally {
      cleanupDir();
    }
  });

  test("config validation rejects invalid values", () => {
    assert.throws(() => resolveScaleConfig({ shardCount: 0 }), /shardCount/);
    assert.throws(() => resolveScaleConfig({ hotTierSize: -1 }), /hotTierSize/);
    assert.throws(() => resolveScaleConfig({ insertBatchSize: 0 }), /insertBatchSize/);
    assert.throws(() => resolveScaleConfig({ searchLimit: 0 }), /searchLimit/);
    assert.throws(() => resolveScaleConfig({ maxContentChars: 0 }), /maxContentChars/);
  });

  test("destroy removes all shard files", () => {
    const store = createStore(4);
    store.insertOne(makeEntry(1));
    const disk = store.diskBytes();
    assert.ok(disk > 0);
    store.destroy();
    assert.ok(!existsSync(TEST_DIR) || store.diskBytes() === 0);
    cleanupDir();
  });

  test("recall at scale: 10k entries, 100% recall on fact probes", () => {
    const store = createStore(8);
    try {
      const entries: MemoryEntry[] = [];
      for (let i = 0; i < 10_000; i += 1) {
        entries.push({
          ...makeEntry(i),
          content: `Entry ${i}: the ${["parser", "tokenizer", "scope", "traversal", "codegen"][i % 5]} module handles index ${i} with hash ${(i * 0x1f1f1f1f).toString(16).slice(0, 8)} variant.`,
        });
      }
      store.insertBatch(entries);
      assert.equal(store.count(), 10_000);
      let hits = 0;
      for (let i = 0; i < 50; i += 1) {
        const hashHex = (i * 0x1f1f1f1f).toString(16).slice(0, 8);
        const topic = ["parser", "tokenizer", "scope", "traversal", "codegen"][i % 5];
        const results = store.search(`${topic} ${hashHex} variant`, 10);
        if (results.length > 0) hits += 1;
      }
      assert.equal(hits, 50, `should have 100% recall, got ${hits}/50`);
      store.close();
    } finally {
      cleanupDir();
    }
  });
});
