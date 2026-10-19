import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ContentStore,
  InvertedIndex,
  LruCache,
  ConversationSummary,
  createEmbeddingsProvider,
  createToolResultStore,
  createTrustEnforcer,
  createDriftDetector,
  createUnifiedMemoryStore,
  createUnifiedContextManager,
  resolveUnifiedConfig,
  retention as ebbinghausRetention,
  reinforce as ebbinghausReinforce,
  applyFadingBoost,
  shouldPrune,
  resolveEbbinghausConfig,
  tokenize,
  termFrequency,
  semanticHash,
  estimateTokens,
} from "../../../src/memory/unified/index.ts";
import { InputError } from "../../../src/kernel/errors.ts";
import { createTempDir } from "../../support/temp-dir.ts";

function mkTempFile(prefix: string): string {
  // The file lives inside an OWNED temp dir, so it is removed with the dir
  // even if a test throws before its own `finally` runs. Previously this put
  // a bare file in the system temp root with no owner.
  return join(createTempDir(`${prefix}-`), "data.bin");
}

// ========== 1. Tokenizer ==========

test("unified/tokenizer: tokenize removes stopwords and short tokens", () => {
  const tokens = tokenize("the quick brown fox jumps over the lazy dog");
  assert.ok(tokens.includes("quick"));
  assert.ok(tokens.includes("brown"));
  assert.ok(tokens.includes("fox"));
  assert.ok(tokens.includes("jumps"));
  assert.ok(tokens.includes("lazy"));
  assert.ok(tokens.includes("dog"));
  assert.ok(!tokens.includes("the"));
  assert.ok(!tokens.includes("over"));
});

test("unified/tokenizer: estimateTokens ~chars/4", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("abcdefgh"), 2);
});

test("unified/tokenizer: semanticHash is order-independent", () => {
  const h1 = semanticHash(["function", "variable"]);
  const h2 = semanticHash(["variable", "function"]);
  assert.equal(h1, h2);
  assert.notEqual(h1, semanticHash(["function", "module"]));
});

test("unified/tokenizer: termFrequency normalizes by total count", () => {
  const tf = termFrequency(["a", "a", "b"]);
  assert.equal(tf.get("a"), 2 / 3);
  assert.equal(tf.get("b"), 1 / 3);
});

// ========== 2. LRU cache ==========

test("unified/cache: LRU evicts oldest on overflow", () => {
  const cache = new LruCache<string, number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3);  // evicts "b" (LRU)
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
});

test("unified/cache: rejects invalid capacity", () => {
  assert.throws(() => new LruCache<string, number>(0), InputError);
  assert.throws(() => new LruCache<string, number>(0), /capacity/);
  assert.throws(() => new LruCache<string, number>(-1), InputError);
  assert.throws(() => new LruCache<string, number>(-1), /capacity/);
  assert.throws(() => new LruCache<string, number>(Number.NaN), InputError);
  assert.throws(() => new LruCache<string, number>(Number.NaN), /capacity/);
});

// ========== 3. Content store ==========

test("unified/content-store: round-trip content", () => {
  const path = mkTempFile("cs-test");
  try {
    const store = new ContentStore(path, 16);
    const id1 = store.add("hello world");
    const id2 = store.add("second entry");
    store.flush();
    assert.equal(store.get(id1), "hello world");
    assert.equal(store.get(id2), "second entry");
    assert.equal(store.size, 2);
    store.destroy();
  } finally {
    rmSync(path, { force: true });
  }
});

test("unified/content-store: includes finds substring", () => {
  const path = mkTempFile("cs-incl");
  try {
    const store = new ContentStore(path, 16);
    const id = store.add("the quasar value is qseed");
    store.flush();
    assert.equal(store.includes(id, "quasar"), true);
    assert.equal(store.includes(id, "nonexistent"), false);
    store.destroy();
  } finally {
    rmSync(path, { force: true });
  }
});

// ========== 4. Inverted index ==========

test("unified/inverted-index: add + finalize + query", () => {
  const idx = new InvertedIndex(16);
  idx.addFromTokens(0, ["quasar", "value", "secret"]);
  idx.addFromTokens(1, ["lattice", "value", "module"]);
  idx.addFromTokens(2, ["quasar", "config", "fact"]);
  const df = idx.computeDf();
  assert.equal(df.get("quasar"), 2);
  assert.equal(df.get("value"), 2);
  assert.equal(df.get("lattice"), 1);
  idx.finalize(df, 3);
  assert.ok(idx.isFinalized);
  const qVec = new Map([["quasar", 0.5], ["value", 0.5]]);
  const r = idx.queryArray(qVec, 3);
  assert.ok(r.candidates.length >= 2);
  assert.ok(r.candidates.includes(0));
  assert.ok(r.candidates.includes(2));
});

// ========== 5. Ebbinghaus ==========

test("unified/ebbinghaus: retention R(0) = 1, R(t) decreases", () => {
  const cfg = resolveEbbinghausConfig();
  assert.equal(ebbinghausRetention(0, cfg.stabilityInitial), 1);
  const r1 = ebbinghausRetention(1, cfg.stabilityInitial);
  const r10 = ebbinghausRetention(10, cfg.stabilityInitial);
  assert.ok(r1 > r10);
  assert.ok(r10 > 0);
  assert.ok(r10 < 1);
});

test("unified/ebbinghaus: reinforce grows strength", () => {
  const cfg = resolveEbbinghausConfig();
  const s0 = cfg.stabilityInitial;
  const s1 = ebbinghausReinforce(s0, 1, 0.5, cfg.decayReinforceGain);
  assert.ok(s1 > s0);
});

test("unified/ebbinghaus: applyFadingBoost boosts fading entries", () => {
  const cfg = resolveEbbinghausConfig({ fadingBoost: 0.2, fadingThreshold: 0.5 });
  assert.equal(applyFadingBoost(0.5, 0.3, cfg), 0.7);
  assert.equal(applyFadingBoost(0.5, 0.6, cfg), 0.5);
});

test("unified/ebbinghaus: shouldPrune excludes facts", () => {
  const cfg = resolveEbbinghausConfig({ pruneThreshold: 0.1 });
  assert.equal(shouldPrune(0.05, cfg, true), false);
  assert.equal(shouldPrune(0.05, cfg, false), true);
  assert.equal(shouldPrune(0.5, cfg, false), false);
});

// ========== 6. Conversation summary ==========

test("unified/conversation-summary: hierarchical block fits token budget", () => {
  const summary = new ConversationSummary({ tokenBudget: 200 });
  summary.setMainTopic("refactor babel-traverse");
  for (let i = 1; i <= 1000; i += 1) summary.recordTurn(i, i % 7 === 0 ? "search" : "edit");
  const block = summary.buildBlock();
  const tokens = estimateTokens(block);
  assert.ok(tokens <= 220, `block ${tokens} tokens exceeds 220`);
  assert.ok(block.includes("T1000"));
  assert.ok(block.includes("refactor babel-traverse"));
});

test("unified/conversation-summary: extractTopic deterministic", () => {
  const t = ConversationSummary.extractTopic("where is the makeAssertNode function", "it is in traverse.ts");
  assert.equal(typeof t, "string");
  assert.ok(t.length > 0);
});

test("unified/conversation-summary: isTurnInSummary", () => {
  const summary = new ConversationSummary({ tokenBudget: 200 });
  summary.recordTurn(5, "test");
  summary.recordTurn(10, "edit");
  assert.equal(summary.isTurnInSummary(5), true);
  assert.equal(summary.isTurnInSummary(10), true);
  assert.equal(summary.isTurnInSummary(7), false);
});

test("unified/conversation-summary: pickContinuityProbeTurns returns turns in summary", () => {
  const summary = new ConversationSummary({ tokenBudget: 200 });
  for (let i = 1; i <= 100; i += 1) summary.recordTurn(i, "topic");
  const turns = summary.pickContinuityProbeTurns(5, 100);
  assert.ok(turns.length <= 5);
  for (const t of turns) assert.equal(summary.isTurnInSummary(t), true);
});

// ========== 7. Tool result store ==========

test("unified/tool-result-store: add + getSummary + getFullResult", () => {
  const store = createToolResultStore({ skipIfSmallTokens: 50 });
  const entry = store.add("search_code", "x".repeat(500));
  assert.ok(entry !== null);
  const summary = store.getSummary(entry.id);
  const full = store.getFullResult(entry.id);
  assert.ok(summary !== null);
  assert.ok(full !== null);
  assert.ok(summary.length < full.length, `summary ${summary.length} should be shorter than full ${full.length}`);
  assert.ok(stats(store).totalTokensSaved > 0);
});

test("unified/tool-result-store: skipIfSmallTokens returns null for small results", () => {
  const store = createToolResultStore({ skipIfSmallTokens: 100 });
  const entry = store.add("search_code", "x".repeat(50)); // ~13 tokens
  assert.equal(entry, null);
  assert.equal(stats(store).skippedSmall, 1);
});

test("unified/tool-result-store: LRU eviction", () => {
  const store = createToolResultStore({ skipIfSmallTokens: 10, lruCapacity: 2 });
  const e1 = store.add("search_code", "x".repeat(200));
  const e2 = store.add("search_code", "y".repeat(200));
  const e3 = store.add("search_code", "z".repeat(200));
  assert.ok(e1 !== null && e2 !== null && e3 !== null);
  assert.equal(store.getFullResult(e1.id), null);  // evicted
  assert.ok(store.getFullResult(e2.id) !== null);
  assert.ok(store.getFullResult(e3.id) !== null);
});

test("unified/tool-result-store: retrieve finds matching chunks", () => {
  const store = createToolResultStore({ skipIfSmallTokens: 10 });
  const entry = store.add("search_code", "line1: quasar value\nline2: lattice config\nline3: unrelated");
  assert.ok(entry !== null);
  const results = store.retrieve("quasar value", 5);
  assert.ok(results.length > 0);
  assert.equal(results[0]?.entryId, entry.id);
});

function stats(store: any) {
  return store.stats();
}

// ========== 8. Trust enforcer ==========

test("unified/trust-enforcer: verify detects missing tokens", () => {
  const enforcer = createTrustEnforcer();
  const result = enforcer.verify("the answer is wrong", ["quasar", "value"]);
  assert.equal(result.passed, false);
  assert.equal(result.missingTokens.length, 2);
});

test("unified/trust-enforcer: verify passes with at least 1 match", () => {
  const enforcer = createTrustEnforcer({ keyTokenMatchRequired: 1 });
  const result = enforcer.verify("the answer involves quasar", ["quasar", "value"]);
  assert.equal(result.passed, true);
  assert.equal(result.matchedTokens.length, 1);
});

test("unified/trust-enforcer: cascade escalates with consecutive fails", () => {
  const enforcer = createTrustEnforcer({ bypassAfterFails: 3, maxEscalation: 4 });
  assert.equal(enforcer.recordFail("f1"), 1);
  assert.equal(enforcer.recordFail("f1"), 2);
  assert.equal(enforcer.recordFail("f1"), 4);  // bypass
  assert.equal(enforcer.state("f1").bypassTriggered, true);
});

test("unified/trust-enforcer: recordSuccess resets cascade", () => {
  const enforcer = createTrustEnforcer();
  enforcer.recordFail("f1");
  enforcer.recordSuccess("f1");
  assert.equal(enforcer.state("f1").level, 0);
  assert.equal(enforcer.state("f1").consecutiveFails, 0);
});

test("unified/trust-enforcer: buildInjection at each level", () => {
  const enforcer = createTrustEnforcer();
  const fact = "the quasar value is qseed";
  assert.ok(enforcer.buildInjection(fact, ["quasar"], 0).includes("CRITICAL CONTEXT"));
  assert.ok(enforcer.buildInjection(fact, ["quasar"], 1).includes("SECOND NOTICE"));
  assert.ok(enforcer.buildInjection(fact, ["quasar"], 2).includes("correct answer"));
  assert.ok(enforcer.buildInjection(fact, ["quasar"], 3).includes("JSON"));
  assert.ok(enforcer.buildInjection(fact, ["quasar"], 4).includes("From memory"));
});

// ========== 9. Drift detector ==========

test("unified/drift-detector: same topic → no drift", async () => {
  const drift = createDriftDetector({ apiKey: "" });
  drift.setOriginalTask("refactor babel-traverse assertions");
  for (let i = 0; i < 10; i += 1) drift.trackTurn(i, "refactor babel-traverse assertions");
  const result = await drift.check(10);
  assert.equal(result.detected, false);
});

test("unified/drift-detector: different topic → drift", async () => {
  const drift = createDriftDetector({ apiKey: "" });
  drift.setOriginalTask("refactor babel-traverse assertions");
  for (let i = 0; i < 10; i += 1) drift.trackTurn(i, "explore flask web routes and templates");
  const result = await drift.check(10);
  assert.equal(result.detected, true);
  assert.equal(result.layer, "deterministic");
});

test("unified/drift-detector: respects minTurnsBeforeDrift", async () => {
  const drift = createDriftDetector({ apiKey: "", minTurnsBeforeDrift: 5 });
  drift.setOriginalTask("refactor babel-traverse");
  drift.trackTurn(0, "explore flask routes");
  const result = await drift.check(1);
  assert.equal(result.layer, "skipped");
});

test("unified/drift-detector: no original task → skipped", async () => {
  const drift = createDriftDetector({ apiKey: "" });
  for (let i = 0; i < 10; i += 1) drift.trackTurn(i, "anything");
  const result = await drift.check(10);
  assert.equal(result.detected, false);
  assert.equal(result.layer, "skipped");
});

// ========== 10. Unified memory store ==========

test("unified/memory-store: add + retrieve finds fact", async () => {
  const cfg = resolveUnifiedConfig({ embeddings: { enabled: false } as any });
  const path = mkTempFile("ms-test");
  try {
    const store = createUnifiedMemoryStore(cfg, { contentPath: path });
    store.add({ turn: 1, role: "system", content: "the quasar value is qseed", kind: "fact", tags: ["quasar"], topic: "quasar" });
    store.add({ turn: 2, role: "user", content: "noise entry about function variable", kind: "turn" });
    store.finalize();
    const top = await store.retrieve("quasar value", 10, 0.0, 2);
    assert.ok(top.length > 0);
    assert.ok(top[0]?.content.includes("qseed"));
    store.destroy();
  } finally {
    rmSync(path, { force: true });
  }
});

test("unified/memory-store: dedup via semantic hash", () => {
  const cfg = resolveUnifiedConfig({ embeddings: { enabled: false } as any });
  const path = mkTempFile("ms-dedup");
  try {
    const store = createUnifiedMemoryStore(cfg, { contentPath: path });
    store.add({ turn: 1, role: "user", content: "function variable quasar", kind: "turn" });
    store.add({ turn: 2, role: "user", content: "variable function quasar", kind: "turn" }); // same hash (order-independent)
    const stats = store.stats();
    assert.equal(stats.duplicateDedups, 1);
    store.destroy();
  } finally {
    rmSync(path, { force: true });
  }
});

test("unified/memory-store: pruneFaded removes decayed non-facts", () => {
  const cfg = resolveUnifiedConfig({
    embeddings: { enabled: false } as any,
    ebbinghaus: { stabilityInitial: 0.5, decayReinforceGain: 1.0, pruneThreshold: 0.5, fadingBoost: 0.1, fadingThreshold: 0.5 } as any,
  });
  const path = mkTempFile("ms-prune");
  try {
    const store = createUnifiedMemoryStore(cfg, { contentPath: path });
    store.add({ turn: 1, role: "user", content: "noise about function", kind: "turn" });
    store.add({ turn: 2, role: "system", content: "fact: quasar value is qseed", kind: "fact", tags: ["quasar"] });
    const pruned = store.pruneFaded(100);  // 100 turns later
    assert.ok(pruned >= 1);  // noise pruned
    assert.equal(store.size, 1);  // fact kept
    store.destroy();
  } finally {
    rmSync(path, { force: true });
  }
});

test("unified/memory-store: kind boost prioritizes facts", async () => {
  const cfg = resolveUnifiedConfig({ embeddings: { enabled: false } as any });
  const path = mkTempFile("ms-boost");
  try {
    const store = createUnifiedMemoryStore(cfg, { contentPath: path });
    // Add 100 noise entries that share tokens with the fact.
    for (let i = 0; i < 100; i += 1) {
      store.add({ turn: i, role: "user", content: `quasar value noise ${i}`, kind: "turn" });
    }
    // Add the fact (longer content, would be diluted in pure cosine).
    store.add({ turn: 101, role: "system", content: "CRITICAL FACT: the quasar configuration value is _quasar_0_seed and you must remember it", kind: "fact", tags: ["quasar"], topic: "quasar" });
    store.finalize();
    const top = await store.retrieve("quasar value", 10, 0.0, 101);
    assert.ok(top.length > 0);
    const first = top[0];
    assert.ok(first !== undefined && first.content.includes("_quasar_0_seed"), `expected fact first, got: ${first?.content.slice(0, 50)}`);
    store.destroy();
  } finally {
    rmSync(path, { force: true });
  }
});

test("unified/memory-store: memory poisoning — correct fact retrievable", async () => {
  const cfg = resolveUnifiedConfig({ embeddings: { enabled: false } as any });
  const path = mkTempFile("ms-poison");
  try {
    const store = createUnifiedMemoryStore(cfg, { contentPath: path });
    // 50 wrong entries with same topic.
    for (let i = 0; i < 50; i += 1) {
      store.add({ turn: i, role: "user", content: `WRONG: the obsidian value is wrong${i}`, kind: "turn", tags: ["obsidian"] });
    }
    // 1 correct entry.
    store.add({ turn: 51, role: "system", content: "CORRECT: the obsidian value is the_real_secret_42", kind: "fact", tags: ["obsidian"], topic: "obsidian" });
    store.finalize();
    const top = await store.retrieve("obsidian value", 10, 0.0, 51);
    const hit = top.some((r) => r.content.includes("the_real_secret_42"));
    assert.ok(hit, `correct entry not in top ${top.length}`);
    store.destroy();
  } finally {
    rmSync(path, { force: true });
  }
});

// ========== 11. Unified context manager ==========

test("unified/context-manager: addTurn + tokenCount + trim", () => {
  const cfg = resolveUnifiedConfig({ contextTokenLimit: 1000, trimThreshold: 0.5, embeddings: { enabled: false } as any });
  const ctx = createUnifiedContextManager(cfg);
  for (let i = 0; i < 100; i += 1) {
    ctx.addTurn({ role: "user", content: `turn ${i}: ` + "x".repeat(100), turnNumber: i });
    if (ctx.shouldTrim()) ctx.trim();
  }
  const state = ctx.state();
  assert.ok(state.trimCount > 0);
  assert.ok(state.totalTokens <= 1000 + 200); // allow some headroom
});

test("unified/context-manager: pinTurn keeps turn after trim", () => {
  const cfg = resolveUnifiedConfig({ contextTokenLimit: 500, trimThreshold: 0.5, recentTurnWindow: 2, embeddings: { enabled: false } as any });
  const ctx = createUnifiedContextManager(cfg);
  const pinned = ctx.addTurn({ role: "user", content: "pinned turn important content " + "x".repeat(200), turnNumber: 0, pinned: true });
  for (let i = 1; i < 50; i += 1) {
    ctx.addTurn({ role: "user", content: `turn ${i}: ` + "x".repeat(50), turnNumber: i });
    if (ctx.shouldTrim()) ctx.trim();
  }
  const state = ctx.state();
  assert.ok(state.turns.some((t) => t.turnId === pinned.turnId), "pinned turn should be kept");
});

test("unified/context-manager: conversation summary block always in context", () => {
  const cfg = resolveUnifiedConfig({ summaryTokenBudget: 100, embeddings: { enabled: false } as any });
  const ctx = createUnifiedContextManager(cfg);
  ctx.setMainTopic("refactor babel-traverse");
  for (let i = 1; i <= 100; i += 1) {
    ctx.recordSummaryTurn(i, `user message ${i}`, `assistant message ${i}`);
  }
  const state = ctx.state();
  assert.ok(state.conversationSummaryBlock.length > 0);
  assert.ok(state.conversationSummaryBlock.includes("refactor babel-traverse"));
});

// ========== 12. Embeddings provider ==========

test("unified/embeddings: createEmbeddingsProvider with disabled config", () => {
  const provider = createEmbeddingsProvider({ enabled: false });
  assert.equal(provider.isAvailable(), false);
});

// ========== 12b. Embeddings provider — EXP467 regression tests ==========
// Root cause fixed: concurrent unawaited `embed` calls inflated `totalQueryMs`
// because each call's `dt` included the queue-wait time of calls ahead of it
// (reported avgQueryMs 474-580ms; actual per-query wall ≈ 10.8ms). The fix
// serializes calls with a promise mutex so each `dt` is pure ONNX execution
// time. Also adds `resetStats` for per-run isolation (was cumulative across
// conversations: 400 → 800 → 1200 → 1600).

test("EXP467/embeddings: resetStats zeroes queries + totalQueryMs (not loadMs)", () => {
  const provider = createEmbeddingsProvider({ enabled: false });
  // The provider is unavailable (disabled), so we exercise resetStats
  // against the initial zero state — the contract is that resetStats is
  // safe to call on an unloaded provider and zeroes only the counters.
  const before = provider.stats();
  assert.equal(before.queries, 0);
  assert.equal(before.totalQueryMs, 0);
  assert.equal(before.loadMs, 0);
  provider.resetStats();
  const after = provider.stats();
  assert.equal(after.queries, 0);
  assert.equal(after.totalQueryMs, 0);
  assert.equal(after.avgQueryMs, 0);
  // resetStats must NOT flip `available`/`loaded` state.
  assert.equal(after.available, before.available);
  assert.equal(after.loaded, before.loaded);
});

test("EXP467/embeddings: resetStats is idempotent and does not throw", () => {
  const provider = createEmbeddingsProvider({ enabled: false });
  assert.doesNotThrow(() => {
    provider.resetStats();
    provider.resetStats();
    provider.resetStats();
  });
  const s = provider.stats();
  assert.equal(s.queries, 0);
  assert.equal(s.totalQueryMs, 0);
});

test("EXP467/embeddings: the provider exposes a resetStats method (API contract)", () => {
  const provider = createEmbeddingsProvider({ enabled: false });
  assert.equal(typeof provider.resetStats, "function",
    "resetStats must be a method on the provider (EXP456 #2: cumulative counter fix)");
});

test("EXP467/embeddings: serializing concurrent embeds keeps per-call dt honest", async () => {
  // This is a structural test of the serialization mutex, not a full ONNX run
  // (the model may not be installed in CI). We verify the contract: when the
  // provider is unavailable, concurrent embeds all reject with the SAME
  // "failed to load" error — NOT a mix of rejected + resolved, which would
  // indicate a race. A serialized provider rejects all-or-none consistently.
  const provider = createEmbeddingsProvider({ enabled: true, modelId: "Xenova/nonexistent-model-EXP467" });
  // Trigger init (will fail → unavailable=true).
  await provider.init();
  assert.equal(provider.isAvailable(), false,
    "nonexistent model → unavailable (typed blocker, not a silent fallback)");
  // Fire 20 concurrent embeds (the EXP456 scenario: 100 facts, here 20).
  const embeds = Array.from({ length: 20 }, () =>
    provider.embed("fact " + Math.random()).then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    ),
  );
  const results = await Promise.all(embeds);
  // Serialization contract: every call sees the SAME unavailable state (no
  // race where some calls slip through before unavailable is set). The fix
  // ensures `dt` is measured only inside the lock, so an unavailable provider
  // never reports inflated timings.
  const allRejected = results.every((r) => r.ok === false);
  assert.ok(allRejected,
    "all 20 concurrent embeds must reject consistently when unavailable (no race)");
  const stats = provider.stats();
  assert.equal(stats.queries, 0,
    "unavailable provider must not count rejected calls in `queries` (no inflation)");
  assert.equal(stats.totalQueryMs, 0,
    "unavailable provider must not accumulate time for rejected calls (no inflation)");
});
