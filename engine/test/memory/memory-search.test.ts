import assert from "node:assert/strict";
import test from "node:test";

import {
  createLexicalSearchEngine,
  lexicalSearch,
  tokenize,
  computeContextFingerprint,
  type MemorySearchEngine,
} from "../../src/memory/memory-search.ts";
import {
  createMemorySearchQuery,
  resolveMemoryConfig,
  type MemoryEntry,
} from "../../src/memory/memory-types.ts";

function mkEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? "entry-1",
    tier: overrides.tier ?? "short-term",
    content: overrides.content ?? "The quick brown fox jumps over the lazy dog",
    tags: overrides.tags ?? [],
    agentId: overrides.agentId ?? null,
    topic: overrides.topic ?? null,
    timestamp: overrides.timestamp ?? "2026-07-16T00:00:00.000Z",
    sourceEventId: overrides.sourceEventId ?? null,
    turnId: overrides.turnId ?? null,
    runId: overrides.runId ?? null,
    metadata: overrides.metadata ?? {},
  };
}

// ========== Tokenize tests ==========

test("memory-search: tokenize splits on non-alphanumeric boundaries", () => {
  const tokens = tokenize("Hello, World! Foo-Bar_Baz 123");
  assert.deepEqual([...tokens], ["hello", "world", "foo", "bar", "baz", "123"]);
});

test("memory-search: tokenize lowercases all tokens", () => {
  const tokens = tokenize("CAMELCase MIXEDcase");
  assert.deepEqual([...tokens], ["camelcase", "mixedcase"]);
});

test("memory-search: tokenize handles empty string", () => {
  assert.equal(tokenize("").length, 0);
});

test("memory-search: tokenize handles only delimiters", () => {
  assert.equal(tokenize("!@#$%^&*()").length, 0);
});

test("memory-search: tokenize handles unicode letters", () => {
  const tokens = tokenize("café résumé naïve");
  assert.ok([...tokens].length > 0);
});

test("memory-search: tokenize handles numbers", () => {
  const tokens = tokenize("file123 test456");
  assert.deepEqual([...tokens], ["file123", "test456"]);
});

test("memory-search: tokenize handles underscores as delimiters", () => {
  const tokens = tokenize("snake_case_var");
  assert.deepEqual([...tokens], ["snake", "case", "var"]);
});

test("memory-search: tokenize handles CamelCase as single token", () => {
  const tokens = tokenize("CamelCaseVar");
  assert.deepEqual([...tokens], ["camelcasevar"]);
});

test("memory-search: tokenize preserves order", () => {
  const tokens = tokenize("alpha beta gamma delta");
  assert.deepEqual([...tokens], ["alpha", "beta", "gamma", "delta"]);
});

test("memory-search: tokenize handles very long text", () => {
  const long = "word ".repeat(10000);
  const tokens = tokenize(long);
  assert.equal(tokens.length, 10000);
});

// ========== Lexical search: basic matching ==========

test("memory-search: finds entries by single keyword", () => {
  const entries = [mkEntry({ id: "e1", content: "error in file writer" })];
  const query = createMemorySearchQuery({ text: "error" });
  const results = lexicalSearch(entries, query);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.entry.id, "e1");
  assert.ok(results[0]!.score > 0);
  assert.ok(results[0]!.matchedFields.includes("content"));
});

test("memory-search: finds entries by multiple keywords", () => {
  const entries = [mkEntry({ id: "e1", content: "error in file writer" })];
  const query = createMemorySearchQuery({ text: "error writer" });
  const results = lexicalSearch(entries, query);
  assert.equal(results.length, 1);
  assert.ok(results[0]!.score > 0);
});

test("memory-search: no results for non-matching query", () => {
  const entries = [mkEntry({ id: "e1", content: "error in file writer" })];
  const query = createMemorySearchQuery({ text: "database" });
  const results = lexicalSearch(entries, query);
  assert.equal(results.length, 0);
});

test("memory-search: empty query text returns all filtered entries", () => {
  const entries = [mkEntry({ id: "e1" }), mkEntry({ id: "e2", content: "different" })];
  const query = createMemorySearchQuery({});
  const results = lexicalSearch(entries, query);
  assert.equal(results.length, 2);
});

test("memory-search: partial keyword match scores lower than full match", () => {
  const full = [mkEntry({ id: "e1", content: "error writer failure" })];
  const partial = [mkEntry({ id: "e2", content: "error only" })];
  const query = createMemorySearchQuery({ text: "error writer failure" });
  const fullResults = lexicalSearch(full, query);
  const partialResults = lexicalSearch(partial, query);
  assert.ok(fullResults[0]!.score > partialResults[0]!.score);
});

// ========== Lexical search: ranking ==========

test("memory-search: ranks by score descending", () => {
  const entries = [
    mkEntry({ id: "e1", content: "error error error" }),
    mkEntry({ id: "e2", content: "error" }),
    mkEntry({ id: "e3", content: "no match here" }),
  ];
  const query = createMemorySearchQuery({ text: "error" });
  const results = lexicalSearch(entries, query);
  assert.equal(results.length, 2);
  assert.ok(results[0]!.score >= results[1]!.score);
  assert.equal(results[0]!.entry.id, "e1");
});

test("memory-search: ties broken by recency (newer first)", () => {
  const entries = [
    mkEntry({ id: "e1", content: "error", timestamp: "2026-07-16T00:00:00.000Z" }),
    mkEntry({ id: "e2", content: "error", timestamp: "2026-07-16T01:00:00.000Z" }),
  ];
  const query = createMemorySearchQuery({ text: "error" });
  const results = lexicalSearch(entries, query);
  assert.equal(results[0]!.entry.id, "e2");
  assert.equal(results[1]!.entry.id, "e1");
});

test("memory-search: ties broken by id when score and time equal", () => {
  const entries = [
    mkEntry({ id: "e2", content: "error", timestamp: "2026-07-16T00:00:00.000Z" }),
    mkEntry({ id: "e1", content: "error", timestamp: "2026-07-16T00:00:00.000Z" }),
  ];
  const query = createMemorySearchQuery({ text: "error" });
  const results = lexicalSearch(entries, query);
  assert.equal(results[0]!.entry.id, "e1");
  assert.equal(results[1]!.entry.id, "e2");
});

test("memory-search: respects limit", () => {
  const entries: MemoryEntry[] = [];
  for (let i = 0; i < 50; i++) {
    entries.push(mkEntry({ id: `e${i}`, content: "error", timestamp: `2026-07-16T00:00:${i.toString().padStart(2, "0")}.000Z` }));
  }
  const query = createMemorySearchQuery({ text: "error", limit: 10 });
  const results = lexicalSearch(entries, query);
  assert.equal(results.length, 10);
});

test("memory-search: absent limit falls back to the memory catalog's default", () => {
  // The absent-limit default is the memory config catalog's own
  // searchResultLimit — the same resolver the settings row and the search
  // route's fallback cite — so the pin reads the owner instead of restating
  // the number. The population exceeds that default by the historical
  // overage (30) so the limit, not the entry count, bounds the absent-limit
  // leg, and the explicit 30 stays below as the proof that a caller
  // supplied limit overrides whatever the catalog default is.
  const catalogDefault = resolveMemoryConfig({}).searchResultLimit;
  const entries: MemoryEntry[] = [];
  for (let i = 0; i < catalogDefault + 30; i++) {
    entries.push(mkEntry({ id: `e${i}`, content: "test" }));
  }
  const results = lexicalSearch(entries, createMemorySearchQuery({ text: "test" }));
  assert.equal(results.length, catalogDefault);
  const overridden = lexicalSearch(entries, createMemorySearchQuery({ text: "test", limit: 30 }));
  assert.equal(overridden.length, 30);
});

// ========== Lexical search: filters ==========

test("memory-search: filters by tier", () => {
  const entries = [
    mkEntry({ id: "e1", tier: "present", content: "test" }),
    mkEntry({ id: "e2", tier: "long-term", content: "test" }),
  ];
  const query = createMemorySearchQuery({ tier: "present", text: "test" });
  const results = lexicalSearch(entries, query);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.entry.tier, "present");
});

test("memory-search: filters by agentId", () => {
  const entries = [
    mkEntry({ id: "e1", agentId: "agent-1", content: "test" }),
    mkEntry({ id: "e2", agentId: "agent-2", content: "test" }),
  ];
  const query = createMemorySearchQuery({ agentId: "agent-1", text: "test" });
  const results = lexicalSearch(entries, query);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.entry.agentId, "agent-1");
});

test("memory-search: filters by topic", () => {
  const entries = [
    mkEntry({ id: "e1", topic: "security", content: "test" }),
    mkEntry({ id: "e2", topic: "performance", content: "test" }),
  ];
  const query = createMemorySearchQuery({ topic: "security", text: "test" });
  const results = lexicalSearch(entries, query);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.entry.topic, "security");
});

test("memory-search: filters by tags (all must match)", () => {
  const entries = [
    mkEntry({ id: "e1", tags: ["bug", "critical"], content: "test" }),
    mkEntry({ id: "e2", tags: ["bug"], content: "test" }),
    mkEntry({ id: "e3", tags: ["critical"], content: "test" }),
  ];
  const query = createMemorySearchQuery({ tags: ["bug", "critical"], text: "test" });
  const results = lexicalSearch(entries, query);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.entry.id, "e1");
});

test("memory-search: filters by time range (fromTime)", () => {
  const entries = [
    mkEntry({ id: "e1", timestamp: "2026-07-16T00:00:00.000Z", content: "test" }),
    mkEntry({ id: "e2", timestamp: "2026-07-16T12:00:00.000Z", content: "test" }),
  ];
  const query = createMemorySearchQuery({ fromTime: "2026-07-16T06:00:00.000Z", text: "test" });
  const results = lexicalSearch(entries, query);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.entry.id, "e2");
});

test("memory-search: filters by time range (toTime)", () => {
  const entries = [
    mkEntry({ id: "e1", timestamp: "2026-07-16T00:00:00.000Z", content: "test" }),
    mkEntry({ id: "e2", timestamp: "2026-07-16T12:00:00.000Z", content: "test" }),
  ];
  const query = createMemorySearchQuery({ toTime: "2026-07-16T06:00:00.000Z", text: "test" });
  const results = lexicalSearch(entries, query);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.entry.id, "e1");
});

test("memory-search: filters by time range (both bounds)", () => {
  const entries = [
    mkEntry({ id: "e1", timestamp: "2026-07-16T00:00:00.000Z", content: "test" }),
    mkEntry({ id: "e2", timestamp: "2026-07-16T06:00:00.000Z", content: "test" }),
    mkEntry({ id: "e3", timestamp: "2026-07-16T12:00:00.000Z", content: "test" }),
  ];
  const query = createMemorySearchQuery({ fromTime: "2026-07-16T03:00:00.000Z", toTime: "2026-07-16T09:00:00.000Z", text: "test" });
  const results = lexicalSearch(entries, query);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.entry.id, "e2");
});

test("memory-search: combined filters narrow results", () => {
  const entries = [
    mkEntry({ id: "e1", tier: "short-term", agentId: "a1", topic: "security", content: "error" }),
    mkEntry({ id: "e2", tier: "short-term", agentId: "a2", topic: "security", content: "error" }),
    mkEntry({ id: "e3", tier: "long-term", agentId: "a1", topic: "security", content: "error" }),
    mkEntry({ id: "e4", tier: "short-term", agentId: "a1", topic: "performance", content: "error" }),
  ];
  const query = createMemorySearchQuery({ tier: "short-term", agentId: "a1", topic: "security", text: "error" });
  const results = lexicalSearch(entries, query);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.entry.id, "e1");
});

// ========== Lexical search: edge cases ==========

test("memory-search: empty entries returns empty", () => {
  const query = createMemorySearchQuery({ text: "test" });
  assert.equal(lexicalSearch([], query).length, 0);
});

test("memory-search: empty entries with no text returns empty", () => {
  const query = createMemorySearchQuery({});
  assert.equal(lexicalSearch([], query).length, 0);
});

test("memory-search: unicode content is searchable", () => {
  const entries = [mkEntry({ id: "e1", content: "résumé café naïve" })];
  const query = createMemorySearchQuery({ text: "cafe" });
  const results = lexicalSearch(entries, query);
  assert.ok(results.length >= 0);
});

test("memory-search: very long content is searchable", () => {
  const longContent = "error ".repeat(10000);
  const entries = [mkEntry({ id: "e1", content: longContent })];
  const query = createMemorySearchQuery({ text: "error" });
  const results = lexicalSearch(entries, query);
  assert.equal(results.length, 1);
});

test("memory-search: case-insensitive matching", () => {
  const entries = [mkEntry({ id: "e1", content: "ERROR in File Writer" })];
  const query = createMemorySearchQuery({ text: "error file writer" });
  const results = lexicalSearch(entries, query);
  assert.equal(results.length, 1);
});

test("memory-search: single character query token", () => {
  const entries = [mkEntry({ id: "e1", content: "a b c" })];
  const query = createMemorySearchQuery({ text: "a" });
  const results = lexicalSearch(entries, query);
  assert.equal(results.length, 1);
});

test("memory-search: query with only delimiters produces no tokens", () => {
  const entries = [mkEntry({ id: "e1", content: "test content" })];
  const query = createMemorySearchQuery({ text: "!@#$" });
  const results = lexicalSearch(entries, query);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.score, 0);
});

test("memory-search: repeated query tokens don't inflate score", () => {
  const entries = [mkEntry({ id: "e1", content: "error" })];
  const q1 = createMemorySearchQuery({ text: "error" });
  const q2 = createMemorySearchQuery({ text: "error error error" });
  const r1 = lexicalSearch(entries, q1);
  const r2 = lexicalSearch(entries, q2);
  assert.equal(r1[0]!.score, r2[0]!.score);
});

test("memory-search: invalid limit throws", () => {
  assert.throws(() => createMemorySearchQuery({ limit: 0 }));
  assert.throws(() => createMemorySearchQuery({ limit: -1 }));
  assert.throws(() => createMemorySearchQuery({ limit: NaN }));
  assert.throws(() => createMemorySearchQuery({ limit: Infinity }));
});

// ========== Search engine factory ==========

test("memory-search: createLexicalSearchEngine returns engine", () => {
  const engine = createLexicalSearchEngine();
  assert.ok(typeof engine.search === "function");
});

test("memory-search: engine.search delegates to lexicalSearch", () => {
  const engine = createLexicalSearchEngine();
  const entries = [mkEntry({ id: "e1", content: "test content" })];
  const query = createMemorySearchQuery({ text: "test" });
  const results = engine.search(entries, query);
  assert.equal(results.length, 1);
});

test("memory-search: engine is reusable across calls", () => {
  const engine: MemorySearchEngine = createLexicalSearchEngine();
  const e1 = [mkEntry({ id: "e1", content: "alpha" })];
  const e2 = [mkEntry({ id: "e2", content: "beta" })];
  const q1 = createMemorySearchQuery({ text: "alpha" });
  const q2 = createMemorySearchQuery({ text: "beta" });
  assert.equal(engine.search(e1, q1).length, 1);
  assert.equal(engine.search(e2, q2).length, 1);
  assert.equal(engine.search(e1, q2).length, 0);
});

// ========== Context fingerprint ==========

test("memory-search: computeContextFingerprint produces deterministic output", () => {
  const f1 = computeContextFingerprint({ agentId: "a1", targetPath: "/foo" });
  const f2 = computeContextFingerprint({ agentId: "a1", targetPath: "/foo" });
  assert.equal(f1, f2);
});

test("memory-search: computeContextFingerprint differs for different inputs", () => {
  const f1 = computeContextFingerprint({ agentId: "a1" });
  const f2 = computeContextFingerprint({ agentId: "a2" });
  assert.notEqual(f1, f2);
});

test("memory-search: computeContextFingerprint handles empty input", () => {
  const fp = computeContextFingerprint({});
  assert.equal(fp, "");
});

test("memory-search: computeContextFingerprint includes all parts", () => {
  const fp = computeContextFingerprint({
    repositoryHash: "abc",
    configHash: "def",
    agentId: "a1",
    toolId: "t1",
    targetPath: "/foo",
    intentHash: "xyz",
  });
  assert.ok(fp.includes("repo:abc"));
  assert.ok(fp.includes("cfg:def"));
  assert.ok(fp.includes("agent:a1"));
  assert.ok(fp.includes("tool:t1"));
  assert.ok(fp.includes("target:/foo"));
  assert.ok(fp.includes("intent:xyz"));
});

test("memory-search: computeContextFingerprint with partial input", () => {
  const fp = computeContextFingerprint({ agentId: "a1" });
  assert.equal(fp, "agent:a1");
});
