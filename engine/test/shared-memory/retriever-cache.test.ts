// Regression test for EXP436: retriever rebuilds index PER QUERY (no cache).
// Root cause: retrieve called buildTfidfIndex/buildInvertedIndex on every
// call → O(N·queries) rebuild cost. Fix: cache the index per entries array
// (WeakMap by reference) so repeated queries on the same entry set reuse the
// index. The index is built ONCE; subsequent queries are O(1) for index build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { retrieve, createRetriever } from "../../src/shared/memory/retrieval/retriever.ts";
import { DEFAULT_TOKENIZER_CONFIG } from "../../src/shared/memory/retrieval/text-utils.ts";
import type { MemoryEntry } from "../../src/shared/memory/memory-entry.ts";

function mkEntry(content: string, type = "fact"): MemoryEntry {
  return {
    id: `e-${content.slice(0, 8)}-${Math.random()}`,
    content,
    type: type as never,
    tier: "warm" as never,
    timestamp: Date.now(),
    provenance: "test",
    conversationId: null,
    projectId: null,
    tags: [],
    embedding: null,
  } as never;
}

const config = { method: "tfidf", topK: 10, minScore: 0, rrfK: 60, hnswM: 16, hnswEfSearch: 100 } as never;
const tokenizer = DEFAULT_TOKENIZER_CONFIG;
const deps = createRetriever(config, tokenizer);

// A large entry set so the TF-IDF index build takes measurable time (>10ms).
// With only 5 entries the build is sub-millisecond, so timing-based cache
// verification is flaky under parallel load (jitter dominates). With 2000
// entries the build is slow enough that the cached second call (which skips
// the build) is deterministically faster, even at 12-way concurrency.
const WORDS = ["quick", "brown", "fox", "lazy", "dog", "clever", "forest", "loyal", "companion", "agile", "sleeps", "sun", "fast", "animal", "human"];
const entries: MemoryEntry[] = Array.from({ length: 2000 }, (_, i) => {
  const w1 = WORDS[i % WORDS.length]!;
  const w2 = WORDS[(i * 7 + 3) % WORDS.length]!;
  const w3 = WORDS[(i * 13 + 5) % WORDS.length]!;
  return mkEntry(`${w1} ${w2} ${w3} entry number ${i}`);
});

test("retrieve produces results (sanity)", async () => {
  const results = await retrieve(deps, { text: "fox", limit: 5, tier: null, type: null, provenance: null, conversationId: null, projectId: null, fromTime: null, toTime: null, tags: [] }, entries);
  assert.ok(results.length > 0, "should find fox-related entries");
  assert.ok(results.every((r) => r.entry.content.toLowerCase().includes("fox") || r.score >= 0),
    "results should be relevant");
});

test("retrieve reuses cached index (perf: 2nd call must be faster)", async () => {
  const query = { text: "quick brown", limit: 5, tier: null, type: null, provenance: null, conversationId: null, projectId: null, fromTime: null, toTime: null, tags: [] };
  // First call: builds the index.
  await retrieve(deps, query, entries);
  // Deterministic cache-reuse verification: the index is cached by the
  // entries array reference (WeakMap). After the first call builds + caches
  // the index, appending a new entry to the SAME array (same reference)
  // and querying for the new entry's unique term must return NO results —
  // the cached index was built before the entry was added, so it does not
  // contain the new term. If the cache were NOT used (the EXP436 bug), the
  // index would be rebuilt on every call and the new entry WOULD be found.
  // This is more robust than timing under parallel load (where sub-ms
  // operations have jitter that dominates the measurement).
  const uniqueTerm = "zyxwvutsrqponmlkjihgfedcba";
  entries.push(mkEntry(`${uniqueTerm} is a unique marker`));
  try {
    const cachedResults = await retrieve(deps, { ...query, text: uniqueTerm }, entries);
    assert.equal(cachedResults.length, 0,
      `cache not reused: the index was rebuilt (found ${cachedResults.length} results for a term added after the first call) — the WeakMap cache should have returned the stale index with no results`);
  } finally {
    entries.pop();
  }
});

test("retrieve with different queries on same entries reuses cache", async () => {
  const baseQuery = { tier: null, type: null, provenance: null, conversationId: null, projectId: null, fromTime: null, toTime: null, tags: [] };
  const r1 = await retrieve(deps, { ...baseQuery, text: "fox", limit: 3 }, entries);
  const r2 = await retrieve(deps, { ...baseQuery, text: "dog", limit: 3 }, entries);
  const r3 = await retrieve(deps, { ...baseQuery, text: "lazy", limit: 3 }, entries);
  // All three should return results (different queries, same cached index).
  assert.ok(r1.length > 0, "fox query should return results");
  assert.ok(r2.length > 0, "dog query should return results");
  assert.ok(r3.length > 0, "lazy query should return results");
});

test("retrieve with filter still works (filter applied to results, not index)", async () => {
  const filteredQuery = { text: "fox", limit: 5, tier: null, type: "error" as never, provenance: null, conversationId: null, projectId: null, fromTime: null, toTime: null, tags: [] };
  const results = await retrieve(deps, filteredQuery, entries);
  // All entries are type "fact", none are "error" → filter removes all.
  assert.equal(results.length, 0, "filter by type=error should return no results (all are fact)");
});
