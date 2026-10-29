import assert from "node:assert/strict";
import test from "node:test";

import {
  hybridSearchSymbols,
  detectSearchBias,
  classifyQuerySpecificity,
  tokenizeSymbolName,
  buildBm25Index,
  bm25ScoreDocument,
} from "../../src/intelligence/symbol-search.ts";
import { resolveIntelligenceConfig } from "../../src/intelligence/intelligence-config.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { threadCpuWorkMs } from "../../src/shared/run-cpu.ts";
import {
  createSymbolSearchQuery,
  type ModuleInfo,
  type RepositoryMap,
  type SymbolInfo,
} from "../../src/intelligence/intelligence-types.ts";

// =============================================================================
// HARD test protocol for the search module (EXP429): 150 queries — 50 vague +
// 50 specific + 50 multi-language name forms. Targets: >80% top-1, 0% wrong-
// directory, <100ms per query. Combines findings from EXP369/383 (BM25),
// EXP397 (hybrid), EXP380 (bias), EXP350 (instant-seal), EXP402 (multi-lang),
// EXP332 (token efficiency).
// =============================================================================

function mkSymbol(overrides: Partial<SymbolInfo> = {}): SymbolInfo {
  return {
    name: overrides.name ?? "foo",
    kind: overrides.kind ?? "function",
    visibility: overrides.visibility ?? "local",
    location: overrides.location ?? { filePath: "src/test.ts", line: 1, column: 1 },
    exported: overrides.exported ?? false,
    async: overrides.async ?? false,
    generator: overrides.generator ?? false,
    parameterCount: overrides.parameterCount ?? 0,
    modifiers: overrides.modifiers ?? [],
  };
}

function mkModule(overrides: Partial<ModuleInfo> = {}): ModuleInfo {
  return {
    path: overrides.path ?? "src/test.ts",
    contentHash: overrides.contentHash ?? "abc123",
    lineCount: overrides.lineCount ?? 10,
    symbols: overrides.symbols ?? [mkSymbol()],
    imports: overrides.imports ?? [],
    exports: overrides.exports ?? [],
    architectureModuleId: overrides.architectureModuleId ?? null,
    architectureLayer: overrides.architectureLayer ?? null,
    architectureRealm: overrides.architectureRealm ?? null,
    architectureOwner: overrides.architectureOwner ?? null,
  };
}

function mkMap(modules: readonly ModuleInfo[]): RepositoryMap {
  return {
    schemaVersion: "bridlewise-intelligence/v1",
    rootPath: ".",
    generatedAt: "2026-07-21T00:00:00.000Z",
    files: modules.map((m) => ({
      path: m.path,
      extension: ".ts" as const,
      sizeBytes: 100,
      contentHash: m.contentHash,
      lineCount: m.lineCount,
      isSource: true,
    })),
    modules,
    totalSymbols: modules.reduce((sum, m) => sum + m.symbols.length, 0),
    totalDependencies: modules.reduce((sum, m) => sum + m.imports.length, 0),
    mapHash: "test-hash",
  };
}

// A realistic repository map spanning multiple directories with many symbols.
// Ground truth: each query's expected symbol is the unique symbol whose name
// matches the query intent.
const REPO_MAP: RepositoryMap = mkMap([
  mkModule({
    path: "src/parser/tokenizer.ts",
    symbols: [
      mkSymbol({ name: "readToken", kind: "function", exported: true, location: { filePath: "src/parser/tokenizer.ts", line: 10, column: 1 } }),
      mkSymbol({ name: "finishToken", kind: "function", exported: true, location: { filePath: "src/parser/tokenizer.ts", line: 45, column: 1 } }),
      mkSymbol({ name: "readStringToken", kind: "function", exported: false, location: { filePath: "src/parser/tokenizer.ts", line: 80, column: 1 } }),
      mkSymbol({ name: "TokenKind", kind: "type", exported: true, location: { filePath: "src/parser/tokenizer.ts", line: 5, column: 1 } }),
    ],
  }),
  mkModule({
    path: "src/parser/statement.ts",
    symbols: [
      mkSymbol({ name: "parseStatement", kind: "function", exported: true, location: { filePath: "src/parser/statement.ts", line: 12, column: 1 } }),
      mkSymbol({ name: "parseExpression", kind: "function", exported: true, location: { filePath: "src/parser/statement.ts", line: 50, column: 1 } }),
      mkSymbol({ name: "parseBlock", kind: "function", exported: true, location: { filePath: "src/parser/statement.ts", line: 90, column: 1 } }),
      mkSymbol({ name: "parseIfStatement", kind: "function", exported: false, location: { filePath: "src/parser/statement.ts", line: 120, column: 1 } }),
    ],
  }),
  mkModule({
    path: "src/memory/memory-store.ts",
    symbols: [
      mkSymbol({ name: "createMemoryStore", kind: "function", exported: true, location: { filePath: "src/memory/memory-store.ts", line: 20, column: 1 } }),
      mkSymbol({ name: "addPresent", kind: "function", exported: false, location: { filePath: "src/memory/memory-store.ts", line: 100, column: 1 } }),
      mkSymbol({ name: "promotePresent", kind: "function", exported: false, location: { filePath: "src/memory/memory-store.ts", line: 150, column: 1 } }),
      mkSymbol({ name: "MemoryStore", kind: "interface", exported: true, location: { filePath: "src/memory/memory-store.ts", line: 10, column: 1 } }),
    ],
  }),
  mkModule({
    path: "src/editor/transactional-editor.ts",
    symbols: [
      mkSymbol({ name: "createTransactionalEditor", kind: "function", exported: true, location: { filePath: "src/editor/transactional-editor.ts", line: 30, column: 1 } }),
      mkSymbol({ name: "applyEdit", kind: "function", exported: false, location: { filePath: "src/editor/transactional-editor.ts", line: 80, column: 1 } }),
      mkSymbol({ name: "applyEditsBatch", kind: "function", exported: false, location: { filePath: "src/editor/transactional-editor.ts", line: 120, column: 1 } }),
      mkSymbol({ name: "EditRequest", kind: "interface", exported: true, location: { filePath: "src/editor/transactional-editor.ts", line: 15, column: 1 } }),
    ],
  }),
  mkModule({
    path: "src/intelligence/symbol-search.ts",
    symbols: [
      mkSymbol({ name: "searchSymbols", kind: "function", exported: true, location: { filePath: "src/intelligence/symbol-search.ts", line: 20, column: 1 } }),
      mkSymbol({ name: "hybridSearchSymbols", kind: "function", exported: true, location: { filePath: "src/intelligence/symbol-search.ts", line: 200, column: 1 } }),
      mkSymbol({ name: "detectSearchBias", kind: "function", exported: true, location: { filePath: "src/intelligence/symbol-search.ts", line: 250, column: 1 } }),
      mkSymbol({ name: "buildBm25Index", kind: "function", exported: true, location: { filePath: "src/intelligence/symbol-search.ts", line: 150, column: 1 } }),
    ],
  }),
]);

// =============================================================================
// Unit tests for the new search primitives.
// =============================================================================

test("exp429 search: tokenizeSymbolName splits camelCase, snake, kebab, paths", () => {
  assert.deepEqual([...tokenizeSymbolName("parseStatement")], ["parse", "statement"]);
  assert.deepEqual([...tokenizeSymbolName("parse_statement")], ["parse", "statement"]);
  assert.deepEqual([...tokenizeSymbolName("parse-statement")], ["parse", "statement"]);
  assert.deepEqual([...tokenizeSymbolName("ParseStatement")], ["parse", "statement"]);
  assert.deepEqual([...tokenizeSymbolName("src/parser/parseStatement")], ["src", "parser", "parse", "statement"]);
  assert.deepEqual([...tokenizeSymbolName("XMLHttpRequest")], ["xml", "http", "request"]);
});

test("exp429 search: classifyQuerySpecificity detects specific vs vague", () => {
  assert.equal(classifyQuerySpecificity("parseStatement"), "specific");
  assert.equal(classifyQuerySpecificity("src/parser/tokenizer"), "specific");
  assert.equal(classifyQuerySpecificity("parse_statement"), "specific");
  assert.equal(classifyQuerySpecificity("fn"), "vague");
  assert.equal(classifyQuerySpecificity("get"), "vague");
  assert.equal(classifyQuerySpecificity("how does the parser work"), "vague");
});

test("exp429 search: buildBm25Index computes document frequencies", () => {
  const index = buildBm25Index(REPO_MAP);
  assert.ok(index.documentCount > 0);
  assert.ok(index.averageDocumentLength > 0);
  // 'parse' appears in multiple documents.
  assert.ok((index.documentFrequencies.get("parse") ?? 0) >= 3);
});

test("exp429 search: bm25ScoreDocument scores matching documents above zero", () => {
  const index = buildBm25Index(REPO_MAP);
  const opts = resolveIntelligenceConfig();
  const matchScore = bm25ScoreDocument(index, "src/parser/statement.ts:parseStatement:12", ["parse", "statement"], opts);
  const missScore = bm25ScoreDocument(index, "src/editor/transactional-editor.ts:applyEdit:80", ["parse", "statement"], opts);
  assert.ok(matchScore > 0);
  assert.ok(missScore === 0 || missScore < matchScore);
});

test("exp429 search: detectSearchBias flags concentration in one directory", () => {
  const results = [
    { symbol: mkSymbol(), filePath: "src/parser/a.ts", score: 1, matchedFields: [] },
    { symbol: mkSymbol(), filePath: "src/parser/b.ts", score: 1, matchedFields: [] },
    { symbol: mkSymbol(), filePath: "src/parser/c.ts", score: 1, matchedFields: [] },
  ];
  assert.equal(detectSearchBias(results, { searchBiasDirectoryThreshold: 0.6 }), true);
  const diverse = [
    { symbol: mkSymbol(), filePath: "src/parser/a.ts", score: 1, matchedFields: [] },
    { symbol: mkSymbol(), filePath: "src/memory/b.ts", score: 1, matchedFields: [] },
    { symbol: mkSymbol(), filePath: "src/editor/c.ts", score: 1, matchedFields: [] },
  ];
  assert.equal(detectSearchBias(diverse, { searchBiasDirectoryThreshold: 0.6 }), false);
});

// =============================================================================
// HARD test: 50 specific queries (BM25-weighted). Ground truth = the exact
// symbol name. Target >80% top-1, 0% wrong-directory.
// =============================================================================

const SPECIFIC_QUERIES: { query: string; expectedSymbol: string; expectedDir: string }[] = [
  { query: "parseStatement", expectedSymbol: "parseStatement", expectedDir: "src/parser" },
  { query: "parseExpression", expectedSymbol: "parseExpression", expectedDir: "src/parser" },
  { query: "parseBlock", expectedSymbol: "parseBlock", expectedDir: "src/parser" },
  { query: "parseIfStatement", expectedSymbol: "parseIfStatement", expectedDir: "src/parser" },
  { query: "readToken", expectedSymbol: "readToken", expectedDir: "src/parser" },
  { query: "finishToken", expectedSymbol: "finishToken", expectedDir: "src/parser" },
  { query: "readStringToken", expectedSymbol: "readStringToken", expectedDir: "src/parser" },
  { query: "TokenKind", expectedSymbol: "TokenKind", expectedDir: "src/parser" },
  { query: "createMemoryStore", expectedSymbol: "createMemoryStore", expectedDir: "src/memory" },
  { query: "addPresent", expectedSymbol: "addPresent", expectedDir: "src/memory" },
  { query: "promotePresent", expectedSymbol: "promotePresent", expectedDir: "src/memory" },
  { query: "MemoryStore", expectedSymbol: "MemoryStore", expectedDir: "src/memory" },
  { query: "createTransactionalEditor", expectedSymbol: "createTransactionalEditor", expectedDir: "src/editor" },
  { query: "applyEdit", expectedSymbol: "applyEdit", expectedDir: "src/editor" },
  { query: "applyEditsBatch", expectedSymbol: "applyEditsBatch", expectedDir: "src/editor" },
  { query: "EditRequest", expectedSymbol: "EditRequest", expectedDir: "src/editor" },
  { query: "searchSymbols", expectedSymbol: "searchSymbols", expectedDir: "src/intelligence" },
  { query: "hybridSearchSymbols", expectedSymbol: "hybridSearchSymbols", expectedDir: "src/intelligence" },
  { query: "detectSearchBias", expectedSymbol: "detectSearchBias", expectedDir: "src/intelligence" },
  { query: "buildBm25Index", expectedSymbol: "buildBm25Index", expectedDir: "src/intelligence" },
  // Token-form variants — same target, different query style.
  { query: "parse_statement", expectedSymbol: "parseStatement", expectedDir: "src/parser" },
  { query: "parse-statement", expectedSymbol: "parseStatement", expectedDir: "src/parser" },
  { query: "parseexpression", expectedSymbol: "parseExpression", expectedDir: "src/parser" },
  { query: "parseblock", expectedSymbol: "parseBlock", expectedDir: "src/parser" },
  { query: "readtoken", expectedSymbol: "readToken", expectedDir: "src/parser" },
  { query: "finishtoken", expectedSymbol: "finishToken", expectedDir: "src/parser" },
  { query: "readstringtoken", expectedSymbol: "readStringToken", expectedDir: "src/parser" },
  { query: "tokenkind", expectedSymbol: "TokenKind", expectedDir: "src/parser" },
  { query: "creatememorystore", expectedSymbol: "createMemoryStore", expectedDir: "src/memory" },
  { query: "addpresent", expectedSymbol: "addPresent", expectedDir: "src/memory" },
  { query: "promotepresent", expectedSymbol: "promotePresent", expectedDir: "src/memory" },
  { query: "memorystore", expectedSymbol: "MemoryStore", expectedDir: "src/memory" },
  { query: "createtransactionaleditor", expectedSymbol: "createTransactionalEditor", expectedDir: "src/editor" },
  { query: "applyedit", expectedSymbol: "applyEdit", expectedDir: "src/editor" },
  { query: "applyeditsbatch", expectedSymbol: "applyEditsBatch", expectedDir: "src/editor" },
  { query: "editrequest", expectedSymbol: "EditRequest", expectedDir: "src/editor" },
  { query: "searchsymbols", expectedSymbol: "searchSymbols", expectedDir: "src/intelligence" },
  { query: "hybridsearchsymbols", expectedSymbol: "hybridSearchSymbols", expectedDir: "src/intelligence" },
  { query: "detectsearchbias", expectedSymbol: "detectSearchBias", expectedDir: "src/intelligence" },
  { query: "buildbm25index", expectedSymbol: "buildBm25Index", expectedDir: "src/intelligence" },
  // Partial subsequence queries.
  { query: "parseState", expectedSymbol: "parseStatement", expectedDir: "src/parser" },
  { query: "parseExpr", expectedSymbol: "parseExpression", expectedDir: "src/parser" },
  { query: "readStr", expectedSymbol: "readStringToken", expectedDir: "src/parser" },
  { query: "createMem", expectedSymbol: "createMemoryStore", expectedDir: "src/memory" },
  { query: "createEditor", expectedSymbol: "createTransactionalEditor", expectedDir: "src/editor" },
  { query: "hybridSearch", expectedSymbol: "hybridSearchSymbols", expectedDir: "src/intelligence" },
  { query: "buildIndex", expectedSymbol: "buildBm25Index", expectedDir: "src/intelligence" },
  { query: "promote", expectedSymbol: "promotePresent", expectedDir: "src/memory" },
  { query: "batch", expectedSymbol: "applyEditsBatch", expectedDir: "src/editor" },
  { query: "bias", expectedSymbol: "detectSearchBias", expectedDir: "src/intelligence" },
];

test("exp429 search HARD: 50 specific queries — top-1 >80%, wrong-dir 0%, <100ms", () => {
  let top1Hits = 0;
  let wrongDir = 0;
  let maxMs = 0;
  for (const { query, expectedSymbol, expectedDir } of SPECIFIC_QUERIES) {
    const q = createSymbolSearchQuery({ name: query, matchMode: "fuzzy", limit: 5 });
    // CPU work, never wall time (NO-LOAD-BLOCK).
    const start = threadCpuWorkMs();
    const result = hybridSearchSymbols(REPO_MAP, q);
    const elapsed = threadCpuWorkMs() - start;
    if (elapsed > maxMs) maxMs = elapsed;
    assert.ok(elapsed < 100, `query '${query}' did ${elapsed}ms of CPU work (limit 100ms)`);
    const top = result.results[0];
    if (top !== undefined && top.symbol.name === expectedSymbol) top1Hits++;
    if (top !== undefined && !top.filePath.startsWith(expectedDir)) wrongDir++;
  }
  const top1Pct = (top1Hits / SPECIFIC_QUERIES.length) * 100;
  assert.ok(top1Pct >= 80, `specific top-1 ${top1Pct}% < 80% (${top1Hits}/${SPECIFIC_QUERIES.length})`);
  assert.equal(wrongDir, 0, `wrong-directory count ${wrongDir} > 0`);
  assert.ok(maxMs < 100, `max query time ${maxMs}ms >= 100ms`);
  // eslint-disable-next-line no-console
  console.log(`  [specific] top-1 ${top1Pct.toFixed(1)}% (${top1Hits}/${SPECIFIC_QUERIES.length}), wrong-dir ${wrongDir}, max ${maxMs.toFixed(2)}ms`);
});

// =============================================================================
// HARD test: 50 vague queries (fuzzy-weighted). These use natural-language-ish
// single tokens or short phrases. Ground truth = the most relevant symbol.
// =============================================================================

const VAGUE_QUERIES: { query: string; expectedSymbol: string; expectedDir: string }[] = [
  // parser-related vague queries
  { query: "parser", expectedSymbol: "parseStatement", expectedDir: "src/parser" },
  { query: "token", expectedSymbol: "readToken", expectedDir: "src/parser" },
  { query: "parse", expectedSymbol: "parseStatement", expectedDir: "src/parser" },
  { query: "statement", expectedSymbol: "parseStatement", expectedDir: "src/parser" },
  { query: "expression", expectedSymbol: "parseExpression", expectedDir: "src/parser" },
  { query: "block", expectedSymbol: "parseBlock", expectedDir: "src/parser" },
  { query: "if", expectedSymbol: "parseIfStatement", expectedDir: "src/parser" },
  { query: "string", expectedSymbol: "readStringToken", expectedDir: "src/parser" },
  { query: "finish", expectedSymbol: "finishToken", expectedDir: "src/parser" },
  { query: "kind", expectedSymbol: "TokenKind", expectedDir: "src/parser" },
  // memory-related vague queries
  { query: "memory", expectedSymbol: "MemoryStore", expectedDir: "src/memory" },
  { query: "store", expectedSymbol: "createMemoryStore", expectedDir: "src/memory" },
  { query: "present", expectedSymbol: "addPresent", expectedDir: "src/memory" },
  { query: "promote", expectedSymbol: "promotePresent", expectedDir: "src/memory" },
  // editor-related vague queries
  { query: "editor", expectedSymbol: "createTransactionalEditor", expectedDir: "src/editor" },
  { query: "edit", expectedSymbol: "applyEdit", expectedDir: "src/editor" },
  { query: "batch", expectedSymbol: "applyEditsBatch", expectedDir: "src/editor" },
  { query: "request", expectedSymbol: "EditRequest", expectedDir: "src/editor" },
  { query: "transactional", expectedSymbol: "createTransactionalEditor", expectedDir: "src/editor" },
  // intelligence-related vague queries
  { query: "search", expectedSymbol: "searchSymbols", expectedDir: "src/intelligence" },
  { query: "hybrid", expectedSymbol: "hybridSearchSymbols", expectedDir: "src/intelligence" },
  { query: "bias", expectedSymbol: "detectSearchBias", expectedDir: "src/intelligence" },
  { query: "index", expectedSymbol: "buildBm25Index", expectedDir: "src/intelligence" },
  { query: "bm25", expectedSymbol: "buildBm25Index", expectedDir: "src/intelligence" },
  { query: "symbols", expectedSymbol: "searchSymbols", expectedDir: "src/intelligence" },
  { query: "intelligence", expectedSymbol: "searchSymbols", expectedDir: "src/intelligence" },
  // compound vague
  { query: "token read", expectedSymbol: "readToken", expectedDir: "src/parser" },
  { query: "parse if", expectedSymbol: "parseIfStatement", expectedDir: "src/parser" },
  { query: "memory store create", expectedSymbol: "createMemoryStore", expectedDir: "src/memory" },
  { query: "editor apply", expectedSymbol: "applyEdit", expectedDir: "src/editor" },
  { query: "search bias", expectedSymbol: "detectSearchBias", expectedDir: "src/intelligence" },
  { query: "build index bm25", expectedSymbol: "buildBm25Index", expectedDir: "src/intelligence" },
  { query: "parse statement block", expectedSymbol: "parseStatement", expectedDir: "src/parser" },
  { query: "promote present memory", expectedSymbol: "promotePresent", expectedDir: "src/memory" },
  { query: "edit request transactional", expectedSymbol: "EditRequest", expectedDir: "src/editor" },
  { query: "finish token parser", expectedSymbol: "finishToken", expectedDir: "src/parser" },
  { query: "read string token", expectedSymbol: "readStringToken", expectedDir: "src/parser" },
  { query: "hybrid search symbols", expectedSymbol: "hybridSearchSymbols", expectedDir: "src/intelligence" },
  { query: "apply edits batch", expectedSymbol: "applyEditsBatch", expectedDir: "src/editor" },
  { query: "create editor transactional", expectedSymbol: "createTransactionalEditor", expectedDir: "src/editor" },
  { query: "add present memory", expectedSymbol: "addPresent", expectedDir: "src/memory" },
  { query: "token kind type", expectedSymbol: "TokenKind", expectedDir: "src/parser" },
  { query: "parse expression statement", expectedSymbol: "parseExpression", expectedDir: "src/parser" },
  { query: "memory store present", expectedSymbol: "createMemoryStore", expectedDir: "src/memory" },
  { query: "editor batch apply", expectedSymbol: "applyEditsBatch", expectedDir: "src/editor" },
  { query: "search symbols intelligence", expectedSymbol: "searchSymbols", expectedDir: "src/intelligence" },
  { query: "detect bias search", expectedSymbol: "detectSearchBias", expectedDir: "src/intelligence" },
  { query: "build bm25 index", expectedSymbol: "buildBm25Index", expectedDir: "src/intelligence" },
  { query: "parse block statement", expectedSymbol: "parseBlock", expectedDir: "src/parser" },
  { query: "create memory store", expectedSymbol: "createMemoryStore", expectedDir: "src/memory" },
];

test("exp429 search HARD: 50 vague queries — top-1 >80%, wrong-dir 0%, <100ms", () => {
  let top1Hits = 0;
  let wrongDir = 0;
  let maxMs = 0;
  for (const { query, expectedSymbol, expectedDir } of VAGUE_QUERIES) {
    const q = createSymbolSearchQuery({ name: query, matchMode: "fuzzy", limit: 5 });
    // CPU work, never wall time (NO-LOAD-BLOCK).
    const start = threadCpuWorkMs();
    const result = hybridSearchSymbols(REPO_MAP, q);
    const elapsed = threadCpuWorkMs() - start;
    if (elapsed > maxMs) maxMs = elapsed;
    assert.ok(elapsed < 100, `vague query '${query}' did ${elapsed}ms of CPU work`);
    const top = result.results[0];
    if (top !== undefined && top.symbol.name === expectedSymbol) top1Hits++;
    if (top !== undefined && !top.filePath.startsWith(expectedDir)) wrongDir++;
  }
  const top1Pct = (top1Hits / VAGUE_QUERIES.length) * 100;
  assert.ok(top1Pct >= 80, `vague top-1 ${top1Pct}% < 80% (${top1Hits}/${VAGUE_QUERIES.length})`);
  assert.equal(wrongDir, 0, `wrong-directory count ${wrongDir} > 0`);
  assert.ok(maxMs < 100, `max query time ${maxMs}ms >= 100ms`);
  // eslint-disable-next-line no-console
  console.log(`  [vague] top-1 ${top1Pct.toFixed(1)}% (${top1Hits}/${VAGUE_QUERIES.length}), wrong-dir ${wrongDir}, max ${maxMs.toFixed(2)}ms`);
});

// =============================================================================
// HARD test: 50 multi-language name-form queries. The same symbol concept
// expressed in camelCase, snake_case, kebab-case, PascalCase, SCREAMING_CASE,
// and path-qualified forms. The repository map uses camelCase; the queries
// vary the form. This implements EXP402 multi-language coverage at the
// search-token layer.
// =============================================================================

const MULTI_LANG_QUERIES: { query: string; expectedSymbol: string; expectedDir: string }[] = [];
const baseNames: { sym: string; dir: string }[] = [
  { sym: "parseStatement", dir: "src/parser" },
  { sym: "parseExpression", dir: "src/parser" },
  { sym: "parseBlock", dir: "src/parser" },
  { sym: "readToken", dir: "src/parser" },
  { sym: "finishToken", dir: "src/parser" },
  { sym: "readStringToken", dir: "src/parser" },
  { sym: "TokenKind", dir: "src/parser" },
  { sym: "createMemoryStore", dir: "src/memory" },
  { sym: "addPresent", dir: "src/memory" },
  { sym: "promotePresent", dir: "src/memory" },
  { sym: "MemoryStore", dir: "src/memory" },
  { sym: "createTransactionalEditor", dir: "src/editor" },
  { sym: "applyEdit", dir: "src/editor" },
  { sym: "applyEditsBatch", dir: "src/editor" },
  { sym: "EditRequest", dir: "src/editor" },
];
const forms: ((s: string) => string)[] = [
  (s) => s, // camelCase (identity)
  (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase(), // snake_case
  (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(), // kebab-case
  (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase(), // SCREAMING_SNAKE
  (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase(), // space-separated
];
for (const base of baseNames) {
  for (const form of forms) {
    MULTI_LANG_QUERIES.push({ query: form(base.sym), expectedSymbol: base.sym, expectedDir: base.dir });
  }
}

test("exp429 search HARD: 50+ multi-language name-form queries — top-1 >80%, <100ms", () => {
  const queries = MULTI_LANG_QUERIES.slice(0, 50);
  let top1Hits = 0;
  let wrongDir = 0;
  let maxMs = 0;
  for (const { query, expectedSymbol, expectedDir } of queries) {
    const q = createSymbolSearchQuery({ name: query, matchMode: "fuzzy", limit: 5 });
    // CPU work, never wall time (NO-LOAD-BLOCK).
    const start = threadCpuWorkMs();
    const result = hybridSearchSymbols(REPO_MAP, q);
    const elapsed = threadCpuWorkMs() - start;
    if (elapsed > maxMs) maxMs = elapsed;
    assert.ok(elapsed < 100, `multi-lang query '${query}' did ${elapsed}ms of CPU work`);
    const top = result.results[0];
    if (top !== undefined && top.symbol.name === expectedSymbol) top1Hits++;
    if (top !== undefined && !top.filePath.startsWith(expectedDir)) wrongDir++;
  }
  const top1Pct = (top1Hits / queries.length) * 100;
  assert.ok(top1Pct >= 80, `multi-lang top-1 ${top1Pct}% < 80% (${top1Hits}/${queries.length})`);
  assert.equal(wrongDir, 0, `wrong-directory count ${wrongDir} > 0`);
  assert.ok(maxMs < 100, `max query time ${maxMs}ms >= 100ms`);
  // eslint-disable-next-line no-console
  console.log(`  [multi-lang] top-1 ${top1Pct.toFixed(1)}% (${top1Hits}/${queries.length}), wrong-dir ${wrongDir}, max ${maxMs.toFixed(2)}ms`);
});

// =============================================================================
// Instant-seal + bias report coverage.
// =============================================================================

test("exp429 search: instant-seal fires when top-1 dominates top-2", () => {
  // Use a unique symbol with no similar siblings so the seal fires.
  const q = createSymbolSearchQuery({ name: "buildBm25Index", matchMode: "fuzzy", limit: 5 });
  const result = hybridSearchSymbols(REPO_MAP, q, { searchSealRatio: 1.5, searchSealMinScore: 0.3 });
  assert.equal(result.sealFired, true, "seal should fire for a confident unique query");
});

test("exp429 search: instant-seal does not fire when results are ambiguous", () => {
  // "parse" matches many parser symbols — seal should not fire.
  const q = createSymbolSearchQuery({ name: "parse", matchMode: "fuzzy", limit: 5 });
  const result = hybridSearchSymbols(REPO_MAP, q, { searchSealRatio: 1.8, searchSealMinScore: 0.5 });
  assert.equal(result.sealFired, false, "seal should not fire for an ambiguous query");
});

test("exp429 search: hybridSearchSymbols returns bias flag", () => {
  // A query that matches only parser symbols will be biased to src/parser.
  const q = createSymbolSearchQuery({ name: "token", matchMode: "fuzzy", limit: 20 });
  const result = hybridSearchSymbols(REPO_MAP, q);
  assert.equal(typeof result.biasDetected, "boolean");
  assert.equal(typeof result.queryClass, "string");
});

// =============================================================================
// The prebuilt index must belong to the map it is used against.
//
// The index exists so a caller serving many queries per map folds the corpus
// once instead of per query — measured at ~4x on a 20k-symbol corpus, which is
// why it is worth having. But an index is a summary of ONE corpus: its
// document frequencies and its average document length are statistics of that
// corpus, so scoring a different one against them yields a ranking that is
// ordered, populated, plausible and computed from the wrong numbers.
//
// Before the check, handing in an index built from a 10-module subset of a
// 500-module map silently changed the top-3. Nothing anywhere said so. The
// only thing standing between a caller and that outcome was a doc comment
// asking them to pass the right one.
// =============================================================================

test("search index: an index built from a different map is refused, not scored", () => {
  const mapA = mkMap([
    mkModule({ path: "src/parser/token.ts", contentHash: "a1", symbols: [mkSymbol({ name: "readTokenValue", location: { filePath: "src/parser/token.ts", line: 10, column: 1 } })] }),
    mkModule({ path: "src/parser/lexer.ts", contentHash: "a2", symbols: [mkSymbol({ name: "readTokenStream", location: { filePath: "src/parser/lexer.ts", line: 20, column: 1 } })] }),
  ]);
  const mapB: RepositoryMap = { ...mkMap([mkModule({ path: "src/other/x.ts", contentHash: "b1" })]), mapHash: "a-different-map" };
  const indexForB = buildBm25Index(mapB);

  assert.throws(
    () => hybridSearchSymbols(mapA, createSymbolSearchQuery({ name: "readToken", matchMode: "fuzzy", limit: 5 }), {}, indexForB),
    (err: unknown) => {
      assert.ok(err instanceof InputError, `expected InputError, got ${err instanceof Error ? err.constructor.name : typeof err}`);
      assert.equal((err as InputError).code, "search_index_map_mismatch");
      assert.match((err as Error).message, /built from a different repository map/u);
      assert.match((err as Error).message, /a-different-map/u);
      return true;
    },
  );
});

test("search index: the index built from THIS map is accepted and changes no answer", () => {
  // The other half of the contract. A check that refuses everything would
  // satisfy the test above and destroy the optimisation it protects.
  const map = mkMap([
    mkModule({ path: "src/parser/token.ts", contentHash: "c1", symbols: [mkSymbol({ name: "readTokenValue", location: { filePath: "src/parser/token.ts", line: 10, column: 1 } })] }),
    mkModule({ path: "src/parser/lexer.ts", contentHash: "c2", symbols: [mkSymbol({ name: "readTokenStream", location: { filePath: "src/parser/lexer.ts", line: 20, column: 1 } })] }),
  ]);
  const q = createSymbolSearchQuery({ name: "readToken", matchMode: "fuzzy", limit: 5 });
  const withIndex = hybridSearchSymbols(map, q, {}, buildBm25Index(map));
  const withoutIndex = hybridSearchSymbols(map, q);
  assert.deepEqual(
    withIndex.results.map((r) => [r.symbol.name, r.score]),
    withoutIndex.results.map((r) => [r.symbol.name, r.score]),
    "reusing the index must not change the ranking it exists to speed up",
  );
  assert.ok(withIndex.results.length > 1, "the fixture must return more than one result for this to mean anything");
});

test("search index: every index records the map it was folded from", () => {
  // The identity has to be ON the index, not derived at the call site, or the
  // caller that forgets to pass it is the caller that most needs the check.
  const map = mkMap([mkModule({ path: "src/a.ts", contentHash: "d1" })]);
  assert.equal(buildBm25Index(map).mapHash, map.mapHash);
});
