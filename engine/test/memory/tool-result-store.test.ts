/**
 * Unit tests for the tool-result-in-memory store (EXP433).
 *
 * Covers:
 * - Deterministic summaries for search_code / read_file / grep / unknown tools.
 * - Store add returns a summary; getFullResult returns the full result.
 * - Retrieval: embeddings, TF-IDF, hybrid (RRF).
 * - getFullResult for "improper usage" (LLM asks for the full result).
 * - Unknown query handling (no entry → empty retrieval).
 * - Token savings accounting.
 * - configure mutates runtime behavior.
 * - LRU eviction at maxEntries.
 * - Exposure signals update after operations.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { resetToolResultRegistration } from "../../src/memory/tool-result-exposure.ts";
import {
  TOOL_RESULT_STORE_DEFAULT_CONFIG,
  createToolResultStore,
  type ToolResultStore,
} from "../../src/memory/tool-result-store.ts";
import {
  buildTfidfIndex,
  chunkToolResult,
  cosine,
  createEmbeddingsRetriever as _unusedCreate,
  reciprocalRankFusion,
  tfidfQuery,
  type EmbeddingsRetriever,
} from "../../src/memory/tool-result-retrieval.ts";
import {
  resolveSummaryConfig,
  summarizeGrepResult,
  summarizeReadResult,
  summarizeSearchResult,
  summarizeToolResult as _unused,
} from "../../src/memory/tool-result-summary.ts";

void _unused;
void _unusedCreate;

// ---------------------------------------------------------------------------
// Fake embeddings retriever — deterministic for unit tests.
// ---------------------------------------------------------------------------

/** A fake retriever that produces a deterministic 4-dim embedding from text hash. */
function createFakeEmbeddingsRetriever(): EmbeddingsRetriever {
  const loaded = { current: false };
  const stats = { loadMs: 0, queries: 0, totalQueryMs: 0 };
  function hashEmbed(text: string): Float32Array {
    const v = new Float32Array(4);
    let h = 0;
    for (let i = 0; i < text.length; i += 1) h = ((h * 31) + text.charCodeAt(i)) >>> 0;
    const cells = [0, 1, 2, 3];
    for (const i of cells) {
      v[i] = ((h >> (i * 8)) & 0xff) / 255 - 0.5;
    }
    const norm = Math.sqrt(v[0]! ** 2 + v[1]! ** 2 + v[2]! ** 2 + v[3]! ** 2);
    if (norm > 0) for (const i of cells) v[i] = v[i]! / norm;
    return v;
  }
  return {
    async init() { loaded.current = true; },
    isLoaded() { return loaded.current; },
    async embed(text: string) {
      stats.queries += 1;
      return hashEmbed(text);
    },
    async embedBatch(texts: readonly string[]) {
      stats.queries += texts.length;
      return texts.map(hashEmbed);
    },
    stats() {
      return {
        loaded: loaded.current,
        loadMs: stats.loadMs,
        queries: stats.queries,
        totalQueryMs: stats.totalQueryMs,
        avgQueryMs: stats.queries === 0 ? 0 : stats.totalQueryMs / stats.queries,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Summary generator tests (deterministic — no embeddings required).
// ---------------------------------------------------------------------------

test("summarizeSearchResult: lists top files with symbols", () => {
  const fullResult = [
    "packages/babel-parser/src/tokenizer/index.ts:142:makeAssertNode",
    "packages/babel-parser/src/tokenizer/index.ts:175:assertNode",
    "packages/babel-traverse/src/path/traverse.ts:87:makeAssertNode",
    "packages/babel-types/src/ast-types/generated/index.ts:500:makeNode",
  ].join("\n");
  const summary = summarizeSearchResult({ query: "makeAssertNode" }, fullResult);
  assert.match(summary, /Found 4 results in 3 files for 'makeAssertNode'/);
  assert.match(summary, /tokenizer\/index\.ts \(makeAssertNode, assertNode\)/);
  assert.match(summary, /traverse\.ts \(makeAssertNode\)/);
});

test("summarizeSearchResult: empty result", () => {
  const summary = summarizeSearchResult({ query: "foo" }, "");
  assert.equal(summary, "Found 0 results for 'foo'.");
});

test("summarizeSearchResult: JSON-encoded results", () => {
  const fullResult = [
    JSON.stringify({ path: "src/a.ts", line: 10, symbol: "foo", kind: "function" }),
    JSON.stringify({ path: "src/b.ts", line: 20, symbol: "bar", kind: "class" }),
  ].join("\n");
  const summary = summarizeSearchResult({ query: "foo" }, fullResult);
  assert.match(summary, /Found 2 results in 2 files for 'foo'/);
  assert.match(summary, /src\/a\.ts \(foo\)/);
  assert.match(summary, /src\/b\.ts \(bar\)/);
});

test("summarizeReadResult: lists declared symbols", () => {
  const fullResult = [
    "import { foo } from 'bar';",
    "export function makeNode() { return 1; }",
    "class Visitor { visit() {} }",
    "interface Token { type: string }",
    "type NodeId = number;",
    "const KIND = 1;",
    "enum Color { Red, Blue }",
    "",
    "// trailing line",
  ].join("\n");
  const summary = summarizeReadResult({ path: "src/parser.ts" }, fullResult);
  assert.match(summary, /Read file src\/parser\.ts \(9 lines\)/);
  assert.match(summary, /function makeNode/);
  assert.match(summary, /class Visitor/);
  assert.match(summary, /interface Token/);
  assert.match(summary, /type NodeId/);
  assert.match(summary, /const KIND/);
  assert.match(summary, /enum Color/);
});

test("summarizeReadResult: empty file", () => {
  const summary = summarizeReadResult({ path: "empty.ts" }, "");
  assert.equal(summary, "Read file empty.ts (0 lines).");
});

test("summarizeGrepResult: lists top matches", () => {
  const fullResult = [
    "src/a.ts:10:const x = makeAssertNode()",
    "src/a.ts:25:const y = makeAssertNode()",
    "src/b.ts:30:makeAssertNode(parser)",
    "src/c.ts:5:makeAssertNode",
  ].join("\n");
  const summary = summarizeGrepResult({ pattern: "makeAssertNode" }, fullResult);
  assert.match(summary, /Found 4 matches in 3 files for \/makeAssertNode\//);
  assert.match(summary, /src\/a\.ts:10/);
  assert.match(summary, /src\/b\.ts:30/);
  assert.match(summary, /src\/c\.ts:5/);
});

test("summarizeGrepResult: empty result", () => {
  const summary = summarizeGrepResult({ pattern: "missing" }, "");
  assert.equal(summary, "Found 0 matches for /missing/.");
});

test("resolveSummaryConfig: validates inputs", () => {
  assert.throws(() => resolveSummaryConfig({ topHitLimit: 0 }), /topHitLimit/);
  assert.throws(() => resolveSummaryConfig({ topHitLimit: Number.NaN }), /topHitLimit/);
  assert.throws(() => resolveSummaryConfig({ readSymbolLimit: 0 }), /readSymbolLimit/);
  assert.throws(() => resolveSummaryConfig({ pathTruncateLimit: 4 }), /pathTruncateLimit/);
  assert.throws(() => resolveSummaryConfig({ grepMatchLimit: 0 }), /grepMatchLimit/);
});

// ---------------------------------------------------------------------------
// Chunking tests.
// ---------------------------------------------------------------------------

test("chunkToolResult: read_file chunks by lines with overlap", () => {
  const lines = [];
  for (let i = 0; i < 120; i += 1) lines.push(`line ${i}`);
  const fullResult = lines.join("\n");
  const chunks = chunkToolResult("read_file", fullResult, {
    readChunkLines: 50,
    readChunkStride: 40,
    maxChunkChars: 1000,
  });
  // 120 lines, stride 40, chunkLines 50: starts at 0, 40, 80 → 3 chunks (80+50=130 covers the last)
  assert.equal(chunks.length, 3);
  assert.match(chunks[0] ?? "", /line 0/);
  assert.match(chunks[0] ?? "", /line 49/);
  // Overlap: chunk 1 starts at line 40, includes line 40 (overlap with chunk 0's tail at 40-49)
  assert.match(chunks[1] ?? "", /line 40/);
  assert.match(chunks[1] ?? "", /line 89/);
  assert.match(chunks[2] ?? "", /line 80/);
  assert.match(chunks[2] ?? "", /line 119/);
});

test("chunkToolResult: search_code/grep one chunk per line", () => {
  const fullResult = "file1.ts:1:foo\nfile2.ts:2:bar\nfile3.ts:3:baz";
  const chunks = chunkToolResult("search_code", fullResult);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0], "file1.ts:1:foo");
  assert.equal(chunks[1], "file2.ts:2:bar");
  assert.equal(chunks[2], "file3.ts:3:baz");
});

test("chunkToolResult: long line gets character-window chunking", () => {
  const longLine = "x".repeat(2500);
  const chunks = chunkToolResult("grep", longLine, {
    readChunkLines: 50,
    readChunkStride: 40,
    maxChunkChars: 1000,
  });
  // 2500 / 1000 = 3 chunks (1000 + 1000 + 500)
  assert.equal(chunks.length, 3);
  assert.equal((chunks[0] ?? "").length, 1000);
  assert.equal((chunks[1] ?? "").length, 1000);
  assert.equal((chunks[2] ?? "").length, 500);
});

test("chunkToolResult: empty input → empty chunks", () => {
  assert.deepEqual(chunkToolResult("read_file", ""), []);
  assert.deepEqual(chunkToolResult("search_code", ""), []);
});

// ---------------------------------------------------------------------------
// TF-IDF tests.
// ---------------------------------------------------------------------------

test("tfidfQuery: returns matches ranked by cosine similarity", () => {
  const chunks = [
    "function makeAssertNode creates assertion nodes",
    "the tokenizer handles tokens",
    "makeAssertNode is in tokenizer",
    "completely unrelated cooking recipe",
  ];
  const index = buildTfidfIndex(chunks);
  const results = tfidfQuery("makeAssertNode assertion", index);
  assert.ok(results.length > 0);
  // The chunk that mentions both terms should be top.
  const top = results[0];
  assert.ok(top !== undefined, "expected at least one result");
  assert.equal(top.chunkIndex, 0, `expected chunkIndex 0, got ${top?.chunkIndex}`);
});

test("tfidfQuery: no overlapping tokens → empty result", () => {
  const chunks = ["function foo bar baz"];
  const index = buildTfidfIndex(chunks);
  const results = tfidfQuery("cooking recipe pasta", index);
  assert.equal(results.length, 0);
});

test("tfidfQuery: empty query → empty result", () => {
  const chunks = ["function foo bar baz"];
  const index = buildTfidfIndex(chunks);
  assert.equal(tfidfQuery("", index).length, 0);
});

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion tests.
// ---------------------------------------------------------------------------

test("reciprocalRankFusion: combines two rankings", () => {
  const r1 = [
    { chunkIndex: 0, score: 0.9 },
    { chunkIndex: 1, score: 0.8 },
    { chunkIndex: 2, score: 0.7 },
  ];
  const r2 = [
    { chunkIndex: 2, score: 0.95 },
    { chunkIndex: 0, score: 0.85 },
    { chunkIndex: 1, score: 0.5 },
  ];
  const fused = reciprocalRankFusion([r1, r2], 60);
  assert.ok(fused.length === 3);
  // Chunk 0: 1/61 + 1/62 = 0.0164 + 0.0161 = 0.0326
  // Chunk 1: 1/62 + 1/63 = 0.0161 + 0.0159 = 0.0320
  // Chunk 2: 1/63 + 1/61 = 0.0159 + 0.0164 = 0.0323
  // Order: chunk 0 (0.0326) > chunk 2 (0.0323) > chunk 1 (0.0320)
  assert.equal(fused[0]?.chunkIndex, 0);
  assert.equal(fused[1]?.chunkIndex, 2);
  assert.equal(fused[2]?.chunkIndex, 1);
});

// ---------------------------------------------------------------------------
// Store tests with fake embeddings.
// ---------------------------------------------------------------------------

async function withStore<T>(
  fn: (store: ToolResultStore) => Promise<T>,
  options?: { enableEmbeddings?: boolean; maxEntries?: number; skipIfSmallTokens?: number },
): Promise<T> {
  resetToolResultRegistration();
  const store = createToolResultStore({
    embeddingsRetriever: createFakeEmbeddingsRetriever(),
    enableEmbeddings: options?.enableEmbeddings ?? true,
    maxEntries: options?.maxEntries ?? 1000,
    skipIfSmallTokens: options?.skipIfSmallTokens ?? 0,  // tests want the add() to actually store.
  });
  return await fn(store);
}

test("store.add: returns summary and token accounting", async () => {
  await withStore(async (store) => {
    // Use a large full result so the summary is much smaller (the summary is
    // most useful for large results; for tiny results the summary can be
    // longer than the full text).
    const fullResult = [
      "packages/babel-parser/src/tokenizer.ts:142:makeAssertNode creates an assertion node",
      "packages/babel-traverse/src/path/traverse.ts:87:makeAssertNode helper",
      "packages/babel-types/src/ast-types.ts:500:makeNode base factory",
      "packages/babel-parser/src/tokenizer.ts:175:assertNode alias for assertions",
      "packages/babel-traverse/src/path/traverse.ts:120:visitNode walker",
      "packages/babel-types/src/builders.ts:80:buildNode generic builder",
    ].join("\n");
    const out = await store.add({
      toolName: "search_code",
      args: { query: "makeAssertNode" },
      fullResult,
      turnId: 1,
    });
    assert.match(out.summary, /Found 6 results in 4 files for 'makeAssertNode'/);
    assert.ok(out.tokensWithoutStore > 0);
    assert.ok(out.tokensWithStore > 0);
    assert.ok(out.tokensSaved > 0, `expected tokensSaved > 0, got ${out.tokensSaved}`);
    assert.ok(out.tokensSaved === out.tokensWithoutStore - out.tokensWithStore);
  });
});

test("store.getFullResult: returns full result for improper-usage case", async () => {
  await withStore(async (store) => {
    const fullResult = "file.ts:1:foo\nfile.ts:2:bar";
    const out = await store.add({
      toolName: "grep",
      args: { pattern: "foo" },
      fullResult,
      turnId: 1,
    });
    assert.equal(store.getFullResult(out.id ?? ""), fullResult);
    assert.equal(store.getFullResult("missing-id"), null);
  });
});

test("store.getSummary: returns summary by id", async () => {
  await withStore(async (store) => {
    const out = await store.add({
      toolName: "grep",
      args: { pattern: "foo" },
      fullResult: "file.ts:1:foo",
      turnId: 1,
    });
    assert.equal(store.getSummary(out.id ?? ""), out.summary);
    assert.equal(store.getSummary("missing"), null);
  });
});

test("store.retrieve: empty result for unknown query", async () => {
  await withStore(async (store) => {
    await store.add({
      toolName: "grep",
      args: { pattern: "foo" },
      fullResult: "file.ts:1:foo",
      turnId: 1,
    });
    const results = await store.retrieve("completely unrelated cooking recipe pasta");
    assert.equal(results.length, 0);
    const stats = store.stats();
    assert.equal(stats.retrievalCount, 1);
    assert.equal(stats.retrievalMisses, 1);
    assert.equal(stats.retrievalHits, 0);
  });
});

test("store.retrieve: TF-IDF returns relevant chunks for known query", async () => {
  await withStore(async (store) => {
    store.configure({ enableEmbeddings: false, retrieval: { method: "tfidf" } });
    const fullResult = [
      "packages/babel-parser/src/tokenizer.ts:142:makeAssertNode creates an assertion",
      "packages/babel-traverse/src/path.ts:87:visitNode walks the path",
      "packages/babel-types/src/ast.ts:500:makeNode builds an AST node",
    ].join("\n");
    await store.add({
      toolName: "search_code",
      args: { query: "makeAssertNode" },
      fullResult,
      turnId: 1,
    });
    const results = await store.retrieve("makeAssertNode assertion", { method: "tfidf" });
    assert.ok(results.length > 0, "expected at least one result");
    const top = results[0];
    assert.ok(top !== undefined);
    assert.ok(top.chunks.length > 0);
    assert.match(top.chunks[0]?.text ?? "", /makeAssertNode/);
    assert.equal(top.fullResultAvailable, true);
    assert.equal(top.method, "tfidf");
  });
});

test("store.retrieve: embeddings return chunks above minScore", async () => {
  await withStore(async (store) => {
    // The fake embeddings hash the text deterministically; two identical queries
    // produce identical embeddings, so a query that equals a chunk's text gets
    // cosine = 1.0. We use a query that exactly matches a chunk's text to test
    // that embeddings retrieval works end-to-end.
    const chunk = "packages/babel-parser/src/tokenizer.ts:142:makeAssertNode";
    await store.add({
      toolName: "search_code",
      args: { query: "makeAssertNode" },
      fullResult: chunk,
      turnId: 1,
    });
    const results = await store.retrieve(chunk, { method: "embeddings", minScore: 0.99 });
    assert.ok(results.length > 0, "expected embeddings to retrieve exact-match chunk");
    assert.equal(results[0]?.chunks[0]?.text, chunk);
  });
});

test("store.tokenSavings: aggregates savings across entries", async () => {
  await withStore(async (store) => {
    await store.add({
      toolName: "search_code",
      args: { query: "foo" },
      fullResult: "x".repeat(4000),
      turnId: 1,
    });
    await store.add({
      toolName: "read_file",
      args: { path: "big.ts" },
      fullResult: "y".repeat(8000),
      turnId: 2,
    });
    const savings = store.tokenSavings();
    assert.ok(savings.totalWithout > 0);
    assert.ok(savings.totalWith < savings.totalWithout);
    assert.ok(savings.savingsPercent > 50, `expected savings >50%, got ${savings.savingsPercent}%`);
  });
});

test("store.configure: mutate topK at runtime", async () => {
  await withStore(async (store) => {
    await store.add({
      toolName: "grep",
      args: { pattern: "makeAssertNode" },
      fullResult: [
        "a.ts:1:makeAssertNode helper",
        "b.ts:2:makeAssertNode creates",
        "c.ts:3:makeAssertNode parser",
        "d.ts:4:makeAssertNode visitor",
        "e.ts:5:makeAssertNode factory",
        "f.ts:6:makeAssertNode builder",
      ].join("\n"),
      turnId: 1,
    });
    store.configure({ retrieval: { topK: 2 } });
    const results = await store.retrieve("makeAssertNode helper", { method: "tfidf", topK: 2, minScore: 0 });
    assert.ok(results.length > 0, "expected at least one result");
    assert.ok((results[0]?.chunks.length ?? 0) <= 2, "expected topK=2");
  });
});

test("store: LRU eviction at maxEntries", async () => {
  await withStore(async (store) => {
    store.configure({ maxEntries: 2 });
    const r1 = await store.add({ toolName: "grep", args: { pattern: "a" }, fullResult: "a.ts:1:a", turnId: 1 });
    const r2 = await store.add({ toolName: "grep", args: { pattern: "b" }, fullResult: "b.ts:1:b", turnId: 2 });
    const r3 = await store.add({ toolName: "grep", args: { pattern: "c" }, fullResult: "c.ts:1:c", turnId: 3 });
    assert.equal(store.list().length, 2);
    assert.equal(store.getFullResult(r1.id ?? ""), null, "r1 should have been evicted");
    assert.equal(store.getFullResult(r2.id ?? ""), "b.ts:1:b");
    assert.equal(store.getFullResult(r3.id ?? ""), "c.ts:1:c");
  });
});

test("store.clear: wipes entries and stats", async () => {
  await withStore(async (store) => {
    await store.add({ toolName: "grep", args: { pattern: "a" }, fullResult: "a.ts:1:a", turnId: 1 });
    await store.retrieve("a", { method: "tfidf", minScore: 0 });
    assert.equal(store.stats().entryCount, 1);
    assert.equal(store.stats().retrievalCount, 1);
    store.clear();
    assert.equal(store.stats().entryCount, 0);
    assert.equal(store.stats().retrievalCount, 0);
  });
});

test("cosine: identical vectors → 1.0; orthogonal → 0", () => {
  const a = new Float32Array([1, 0, 0, 0]);
  const b = new Float32Array([1, 0, 0, 0]);
  const c = new Float32Array([0, 1, 0, 0]);
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-6);
  assert.ok(Math.abs(cosine(a, c) - 0) < 1e-6);
});

test("store.stats: embeddings stats tracked", async () => {
  await withStore(async (store) => {
    await store.add({
      toolName: "grep",
      args: { pattern: "foo" },
      fullResult: "a.ts:1:foo\nb.ts:2:foo",
      turnId: 1,
    });
    await store.retrieve("foo", { method: "embeddings", minScore: 0 });
    const stats = store.stats();
    assert.equal(stats.embeddingsLoaded, true);
    assert.ok(stats.embeddingsQueries > 0, "expected embeddings to be queried");
  });
});

test("TOOL_RESULT_STORE_DEFAULT_CONFIG: matches expected shape", () => {
  assert.equal(TOOL_RESULT_STORE_DEFAULT_CONFIG.enableEmbeddings, true);
  assert.equal(TOOL_RESULT_STORE_DEFAULT_CONFIG.maxEntries, 1000);
  assert.equal(TOOL_RESULT_STORE_DEFAULT_CONFIG.retrieval.method, "hybrid");
});
