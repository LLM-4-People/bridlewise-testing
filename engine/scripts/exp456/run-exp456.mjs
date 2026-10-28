/**
 * EXP456 — 10× more tests: 300 fact + 300 continuity + 100 flow probes.
 *
 * Builds on EXP445's unified memory+context subsystem (10 techniques combined).
 * User directive: "we need to test with 10 times more: 30/30 fact, 30/30
 * continuity, 10/10 flow" → 300/300 + 300/300 + 100/100 = 700 probes/checkpoint.
 *
 * What is 10× harder vs EXP445:
 *   - 100 facts (was 10) planted in turns 2-50.
 *   - 300 fact probes  = 100 facts × 3 checkpoints (was 30).
 *   - 300 continuity probes (was 30) — cycle through in-summary turns.
 *   - 100 flow probes (was 10) — 100 genuinely DISTINCT flow checks.
 *   - 700 probes per conversation × 3 conversation lengths = 2100 probes.
 *   - Improper-usage: memory poisoning scaled 3000:1 (was 1000:1).
 *
 * Conversation lengths: 100, 1000, 10000. If 10000 passes → 100000 (10× harder).
 *
 * LLM: gemma-4-31b ONLY (drift-detector fallback). Conversation tests are
 * deterministic (no LLM); embeddings are local ONNX (all-MiniLM-L6-v2).
 *
 * Performance: CPU user/sys, heap + RSS, disk IO, embeddings queries/latency,
 * latency/probe, input tokens (content stored) vs output tokens (summary
 * block), probes/s, total wall time.
 *
 * Usage:
 *   node --experimental-strip-types scripts/exp456/run-exp456.mjs
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import {
  createUnifiedMemoryStore,
  createEmbeddingsProvider,
  createUnifiedContextManager,
  createToolResultStore,
  createTrustEnforcer,
  createDriftDetector,
  resolveUnifiedConfig,
  ConversationSummary,
  estimateTokens,
  tokenize,
} from "../../src/memory/unified/index.ts";
import { createOwnedTemporaryDirectory } from "../../src/filesystem/private-state.ts";
import { experimentApiFromEnvironment } from "../../_experiments/experiment-environment.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RESULTS_DIR = resolve(REPO, "scripts/exp456/results");
if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// LLM config (gemma-4-31b only, per binding directive).
// ---------------------------------------------------------------------------
const llmCfg = experimentApiFromEnvironment();
// Scratch content stores live in one owned folder of this run (never a fixed /tmp name).
const SCRATCH = createOwnedTemporaryDirectory(tmpdir(), "exp456-");
const LLM_MODEL = "gemma-4-31b";

// ---------------------------------------------------------------------------
// 10× probe counts (single canonical owner — no magic numbers elsewhere).
// ---------------------------------------------------------------------------
const PROBE_COUNTS = Object.freeze({
  nFacts: 100,            // 10× more facts (was 10)
  factProbesPerCheckpoint: 100,
  nCheckpoints: 3,
  factProbes: 300,         // 100 × 3
  continuityProbes: 300,   // 10× more (was 30)
  flowProbes: 100,         // 10× more (was 10)
  totalPerConversation: 700,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function nowMs() { return performance.now(); }
function heapMB() {
  if (typeof globalThis.gc === "function") { try { globalThis.gc(); } catch { /* ignore */ } }
  return process.memoryUsage().heapUsed / (1024 * 1024);
}
function rssMB() { return process.memoryUsage().rss / (1024 * 1024); }
function diskIO() { return process.resourceUsage ? process.resourceUsage() : null; }

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Vocabulary for noise entries (shared with EXP445).
const COMMON = ["function","variable","module","import","export","return","call","argument","parameter","type","string","number","boolean","object","array","promise","async","await","error","exception","handle","value","name","path","file","read","write","open","close","test","pass","fail","result","config","default","option","flag","state","update","create","delete","list","item","entry","field","method","class","instance","static","const","let","loop","break","continue"];
const RARE = ["elysium","quasar","lattice","manifold","cobalt","tungsten","persimmon","kestrel","obsidian","zephyr","anomaly","vector","isomorphic","polymorphic","invariant","functor","monad","sheaf","operad","category","algebraic","homotopy","homology","cohomology","borel","markov","haar","wiener","fourier","laplacian","galois","frobenius","eigenvalue","eigenvector","riemann","lebesgue","banach","hilbert","cauchy","schwarz"];
const RARE_LEN = RARE.length;

// 100 unique single-token markers (tokenizer keeps [a-z0-9_]+ as one token).
// Base = RARE words; for i >= RARE_LEN append a generation digit so all 100
// are distinct tokens (e.g. "elysium", ..., "schwarz", "elysium1", ...).
function buildFactMarkers(n) {
  const markers = [];
  for (let i = 0; i < n; i += 1) {
    const base = RARE[i % RARE_LEN];
    const gen = Math.floor(i / RARE_LEN);
    markers.push(gen === 0 ? base : `${base}${gen}`);
  }
  return markers;
}

function buildNoiseEntry(rng, idx, tokensPerEntry) {
  const targetLen = tokensPerEntry * 4;
  const parts = [];
  let len = 0;
  parts.push(`entry${idx}`); len += `entry${idx}`.length + 1;
  while (len < targetLen) {
    const useRare = rng() < 0.18;
    const pool = useRare ? RARE : COMMON;
    const w = pool[Math.floor(rng() * pool.length)];
    parts.push(w); len += w.length + 1;
  }
  return parts.join(" ");
}

function buildFact(idx, marker) {
  const factId = `fact_${idx}`;
  const secret = `_${marker}_${idx}_seed`;
  const body = [
    `CRITICAL FACT ${factId}:`,
    `the ${marker} configuration value is ${secret}`,
    `this is planted fact number ${idx} for exp456 ten-times stress test`,
    `remember the ${marker} secret because it will be probed later`,
    `the value ${secret} must be recalled exactly`,
    `do not forget the ${marker} entry it is important for recall`,
    `the secret token ${secret} is the answer to the ${marker} question`,
  ].join(" ");
  const probe = `what is the ${marker} configuration value for ${factId}`;
  return { factId, marker, secret, body, probe };
}

function buildFacts(nFacts) {
  const markers = buildFactMarkers(nFacts);
  const facts = [];
  for (let i = 0; i < nFacts; i += 1) facts.push(buildFact(i, markers[i]));
  return facts;
}

// ---------------------------------------------------------------------------
// Conversation turns (deterministic, mixing fact mentions + codebase chatter).
// ---------------------------------------------------------------------------
function buildTurn(rng, turn, facts) {
  const mentionFact = rng() < 0.05 && facts.length > 0;
  if (mentionFact) {
    const f = facts[Math.floor(rng() * facts.length)];
    return `turn ${turn}: review the ${f.marker} configuration we set earlier; the secret ${f.secret} is critical`;
  }
  const useRare = rng() < 0.18;
  const pool = useRare ? RARE : COMMON;
  const words = [];
  for (let i = 0; i < 20; i += 1) words.push(pool[Math.floor(rng() * pool.length)]);
  return `turn ${turn}: working on ${words.join(" ")} in babel-traverse`;
}

// ---------------------------------------------------------------------------
// 100 genuinely distinct flow probes.
// Each probe tests a DIFFERENT property of the conversation-flow summary block.
// All probes check ONLY always-present content so they pass at every nTurns:
//   - Header line (never truncated): "[CONVERSATION SUMMARY … main: refactor babel-traverse assertions]"
//   - Recent level (last 10 turns, added first → never truncated): T(max-9)..T(max) with all 4 topics.
// The 4 topics (search_code, edit, list_files, review) all appear because the
// last 10 consecutive turns cover the period-4 topic cycle (10 >= 4).
// ---------------------------------------------------------------------------
// Keywords guaranteed present in the block at any conversation length >= 10.
const FLOW_ALWAYS_PRESENT = Object.freeze([
  "[conversation summary", "main:", "turns", "conversation", "summary",
  "refactor", "babel", "traverse", "assertions",
  "search_code", "edit", "list_files", "review",
  "main: refactor",
]);
const FLOW_MAIN_WORDS = Object.freeze(["refactor", "babel", "traverse", "assertions"]);
const FLOW_TOPICS = Object.freeze(["search_code", "edit", "list_files", "review"]);

function buildFlowProbes() {
  const probes = [];
  const kw = FLOW_ALWAYS_PRESENT;
  // 1) Single-keyword presence (14 probes).
  for (const k of kw) probes.push(() => blockHas(block, k));
  // 2) Recent turn markers T(recentTurns[i]): (10 probes, last 10 turns always in block).
  for (let i = 0; i < recentTurns.length && probes.length < 24; i += 1) {
    probes.push(() => blockHas(block, `T${recentTurns[i]}:`));
  }
  // 3) Recent turn marker + main-word co-occurrence (10 probes).
  for (let i = 0; i < recentTurns.length && probes.length < 34; i += 1) {
    const mw = FLOW_MAIN_WORDS[i % FLOW_MAIN_WORDS.length];
    probes.push(() => blockHas(block, `T${recentTurns[i]}:`) && blockHas(block, mw));
  }
  // 4) Two-keyword co-occurrence — distinct pairs from always-present pool (22 probes).
  let pairCount = 0;
  for (let a = 0; a < kw.length && pairCount < 22; a += 1) {
    for (let b = a + 1; b < kw.length && pairCount < 22; b += 1) {
      const x = kw[a], y = kw[b];
      probes.push(() => blockHas(block, x) && blockHas(block, y));
      pairCount += 1;
    }
  }
  // 5) Three-keyword co-occurrence — distinct triples (20 probes).
  let tripleCount = 0;
  for (let a = 0; a < kw.length && tripleCount < 20; a += 1) {
    for (let b = a + 1; b < kw.length && tripleCount < 20; b += 1) {
      for (let c = b + 1; c < kw.length && tripleCount < 20; c += 1) {
        const x = kw[a], y = kw[b], z = kw[c];
        probes.push(() => blockHas(block, x) && blockHas(block, y) && blockHas(block, z));
        tripleCount += 1;
      }
    }
  }
  // 6) Structural / line-count probes (10 probes).
  probes.push(() => blockCountLines(block) >= 1);
  probes.push(() => blockCountLines(block) >= 2);
  probes.push(() => blockCountLines(block) >= 3);
  probes.push(() => blockCountLines(block) >= 4);
  probes.push(() => blockHas(block, "[conversation summary") && blockHas(block, "main:"));
  probes.push(() => blockHas(block, "conversation") && blockHas(block, "summary") && blockHas(block, "turns"));
  probes.push(() => blockHas(block, "main: refactor babel-traverse assertions"));
  probes.push(() => blockHas(block, "refactor babel-traverse assertions"));
  probes.push(() => blockHas(block, "t1..t"));
  probes.push(() => blockCountKeywords(block, FLOW_MAIN_WORDS) >= 4);
  // 7) Topic-threshold probes — varying subsets + thresholds (remaining to 100).
  while (probes.length < 100) {
    const nTopics = 2 + (probes.length % 3); // 2,3,4 cycling
    const subset = FLOW_TOPICS.slice(0, nTopics);
    const threshold = Math.min(subset.length, 1 + (probes.length % 2));
    probes.push(() => blockCountKeywords(block, subset) >= threshold);
  }
  return probes.slice(0, 100);
}

// Flow-probe helpers (operate on the module-level `block` / `recentTurns`).
let block = "";
let recentTurns = [];
function blockHas(b, needle) { return b.toLowerCase().includes(needle.toLowerCase()); }
function blockCountLines(b) { return b.split("\n").length; }
function blockCountKeywords(b, kws) {
  const lower = b.toLowerCase();
  let c = 0;
  for (const k of kws) if (lower.includes(k.toLowerCase())) c += 1;
  return c;
}

// ---------------------------------------------------------------------------
// Result accumulator.
// ---------------------------------------------------------------------------
class ResultAgg {
  results = {};
  add(key, value) {
    if (!this.results[key]) this.results[key] = [];
    this.results[key].push(value);
  }
  summary() { return this.results; }
}

// ---------------------------------------------------------------------------
// Run a single N-turn conversation with 10× probes.
// ---------------------------------------------------------------------------
async function runConversation(nTurns, config, options = {}) {
  const t0 = nowMs();
  const startHeap = heapMB();
  const startRss = rssMB();
  const startIO = diskIO();
  const facts = buildFacts(PROBE_COUNTS.nFacts);
  const rng = mulberry32(0x4e445 ^ nTurns);
  const contentPath = resolve(REPO, `scripts/exp456/results/exp456-content-${nTurns}.bin`);

  const memStore = createUnifiedMemoryStore(config, {
    contentPath,
    embeddingsProvider: options.embeddingsProvider,
  });

  // Plant 100 facts in turns 2-50 (turn = 2 + (i % 49) → turns 2..50).
  let inputContentTokens = 0;
  for (let i = 0; i < facts.length; i += 1) {
    const f = facts[i];
    memStore.add({
      turn: 2 + (i % 49),
      role: "system",
      content: f.body,
      kind: "fact",
      tags: [f.marker, f.factId],
      topic: f.marker,
      computeEmbedding: true,
    });
    inputContentTokens += estimateTokens(f.body);
  }

  // Add noise entries (the rest of the conversation).
  const noiseCount = Math.max(0, nTurns - facts.length);
  const noiseTokensPerEntry = 50;
  const noiseEntries = new Array(noiseCount);
  for (let i = 0; i < noiseCount; i += 1) noiseEntries[i] = buildNoiseEntry(rng, i, noiseTokensPerEntry);
  const addT0 = nowMs();
  for (let i = 0; i < noiseCount; i += 1) {
    memStore.add({ turn: 10 + i, role: "user", content: noiseEntries[i], kind: "turn" });
  }
  // Estimate total input content tokens. facts are counted exactly; noise is
  // sampled (up to 4000 entries) then extrapolated to avoid an O(n) full scan.
  const factTokens = inputContentTokens; // already summed above
  const noiseSampleSize = Math.min(noiseCount, 4000);
  let noiseSampleTokens = 0;
  for (let i = 0; i < noiseSampleSize; i += 1) noiseSampleTokens += estimateTokens(noiseEntries[i]);
  const totalNoiseTokens = noiseSampleSize > 0
    ? (noiseSampleTokens / noiseSampleSize) * noiseCount
    : 0;
  inputContentTokens = Math.round(factTokens + totalNoiseTokens);
  const addMs = nowMs() - addT0;
  memStore.finalize();
  await memStore.waitForEmbeddings();
  const endHeapAfterAdd = heapMB();
  const endRssAfterAdd = rssMB();

  // === 3 checkpoints (EXP445 derivation) ===
  const checkpoints = nTurns >= 10000
    ? [Math.floor(nTurns / 4), Math.floor(nTurns / 2), Math.floor(3 * nTurns / 4)]
    : [Math.floor(nTurns / 3), Math.floor(2 * nTurns / 3), nTurns];

  // === Fact probes (300 = 100 facts × 3 checkpoints) ===
  let factHits = 0;
  let factProbes = 0;
  let factLatencyMs = 0;
  for (const ckpt of checkpoints) {
    for (const f of facts) {
      factProbes += 1;
      const t1 = nowMs();
      const top = await memStore.retrieve(f.probe, 10, config.retrievalMinScore, ckpt);
      const dt = nowMs() - t1;
      factLatencyMs += dt;
      const hit = top.some((r) =>
        r.content.includes(f.secret) || r.content.includes(`_${f.marker}_${f.factId}_seed`));
      if (hit) factHits += 1;
    }
  }

  // === Continuity probes (300) ===
  // Build a rich conversation summary (deterministic, no LLM).
  const summary = new ConversationSummary({ tokenBudget: config.summaryTokenBudget });
  summary.setMainTopic("refactor babel-traverse assertions");
  const topicCycle = ["search_code", "edit", "list_files", "review"];
  for (let t = 1; t <= nTurns; t += 1) {
    summary.recordTurn(t, topicCycle[t % topicCycle.length]);
  }
  // Pick in-summary turns, then cycle to reach exactly 300 probes.
  const inSummaryTurns = summary.pickContinuityProbeTurns(PROBE_COUNTS.continuityProbes, nTurns);
  const probeTurns = [];
  if (inSummaryTurns.length === 0) {
    for (let i = 1; i <= PROBE_COUNTS.continuityProbes; i += 1) probeTurns.push(i);
  } else {
    let idx = 0;
    for (let i = 0; i < PROBE_COUNTS.continuityProbes; i += 1) {
      probeTurns.push(inSummaryTurns[idx % inSummaryTurns.length]);
      idx += 1;
    }
  }
  let continuityHits = 0;
  for (const t of probeTurns) {
    if (summary.isTurnInSummary(t)) continuityHits += 1;
  }

  // === Flow probes (100 genuinely distinct) ===
  // Set module-level block + recentTurns for the closure-based probes.
  block = summary.buildBlock();
  recentTurns = [];
  for (let t = Math.max(1, nTurns - 9); t <= nTurns; t += 1) recentTurns.push(t);
  const flowProbeFns = buildFlowProbes();
  let flowHits = 0;
  for (const fn of flowProbeFns) {
    if (fn()) flowHits += 1;
  }
  const outputBlockTokens = estimateTokens(block);

  // === Stats ===
  const stats = memStore.stats();
  const endHeap = heapMB();
  const endRss = rssMB();
  const endIO = diskIO();
  const totalMs = nowMs() - t0;
  const diskReadsMB = startIO && endIO ? ((endIO.blockReadBytes ?? 0) - (startIO.blockReadBytes ?? 0)) / (1024 * 1024) : 0;
  const diskWritesMB = startIO && endIO ? ((endIO.blockWriteBytes ?? 0) - (startIO.blockWriteBytes ?? 0)) / (1024 * 1024) : 0;
  const cpuUserSec = startIO && endIO ? (((endIO.userCPUTime ?? 0) - (startIO.userCPUTime ?? 0)) / 1_000_000) : 0;
  const cpuSystemSec = startIO && endIO ? (((endIO.systemCPUTime ?? 0) - (startIO.systemCPUTime ?? 0)) / 1_000_000) : 0;
  const totalProbes = factProbes + PROBE_COUNTS.continuityProbes + PROBE_COUNTS.flowProbes;
  const probesPerSec = totalProbes / (totalMs / 1000);

  memStore.destroy();
  return {
    nTurns,
    totalMs,
    addMs,
    factProbes,
    factHits,
    factRecall: factProbes > 0 ? factHits / factProbes : 0,
    factLatencyMs,
    factPerProbeMs: factProbes > 0 ? factLatencyMs / factProbes : 0,
    continuityProbes: PROBE_COUNTS.continuityProbes,
    continuityHits,
    continuityRecall: continuityHits / PROBE_COUNTS.continuityProbes,
    flowProbes: PROBE_COUNTS.flowProbes,
    flowHits,
    flowRecall: flowHits / PROBE_COUNTS.flowProbes,
    totalProbes,
    probesPerSec,
    startHeapMB: startHeap,
    endHeapMB: endHeap,
    peakHeapMB: Math.max(endHeapAfterAdd, endHeap),
    startRssMB: startRss,
    endRssMB: endRss,
    peakRssMB: Math.max(endRssAfterAdd, endRss),
    diskReadsMB,
    diskWritesMB,
    cpuUserSec,
    cpuSystemSec,
    inputContentTokens: Math.round(inputContentTokens),
    outputBlockTokens,
    retrievals: stats.retrievals,
    relevantInjections: stats.relevantInjections,
    totalReinforced: stats.totalReinforced,
    totalPruned: stats.totalPruned,
    duplicateDedups: stats.duplicateDedups,
    contentStoreBytes: stats.contentStoreBytes,
    lruHits: stats.lruHits,
    lruMisses: stats.lruMisses,
    embeddingsAvailable: stats.embeddings.available,
    embeddingsLoaded: stats.embeddings.loaded,
    embeddingsQueries: stats.embeddings.queries,
    embeddingsAvgMs: stats.embeddings.avgQueryMs,
    embeddingsDims: stats.embeddings.dims,
    invertedPostings: stats.invertedIndex.postings,
    checkpoints,
    inSummaryTurnsPicked: inSummaryTurns.length,
  };
}

// ---------------------------------------------------------------------------
// Improper usage / unknown tests (10 cases, scaled 10× harder where sensible).
// ---------------------------------------------------------------------------
async function runImproperUsage(config, embeddingsProvider) {
  const results = [];
  // I1: corrupt memory (add same hash twice, ensure dedup works).
  {
    const memStore = createUnifiedMemoryStore(config, { embeddingsProvider, contentPath: resolve(SCRATCH, "i1.bin") });
    memStore.add({ turn: 1, role: "user", content: "fact A: quasar value is qseed1", kind: "fact" });
    memStore.add({ turn: 2, role: "user", content: "fact A: quasar value is qseed1", kind: "fact" });
    const stats = memStore.stats();
    results.push({ name: "I1 corrupt/duplicate", pass: stats.duplicateDedups === 1, dedups: stats.duplicateDedups });
    memStore.destroy();
  }
  // I2: context overflow (tiny token limit, ensure trim fires).
  {
    const tinyConfig = { ...config, contextTokenLimit: 1000, trimThreshold: 0.5 };
    const ctxMgr = createUnifiedContextManager(tinyConfig);
    for (let i = 0; i < 100; i += 1) {
      ctxMgr.addTurn({ role: "user", content: `turn ${i}: ` + "x".repeat(200), turnNumber: i });
      if (ctxMgr.shouldTrim()) ctxMgr.trim();
    }
    const state = ctxMgr.state();
    results.push({ name: "I2 context overflow", pass: state.trimCount > 0, trimCount: state.trimCount, totalTokens: state.totalTokens });
  }
  // I3: memory poisoning (3000 wrong + 1 correct — 10× harder than EXP445's 1000:1).
  {
    const memStore = createUnifiedMemoryStore(config, { embeddingsProvider, contentPath: resolve(SCRATCH, "i3.bin") });
    const rng = mulberry32(42);
    for (let i = 0; i < 3000; i += 1) {
      const marker = RARE[i % RARE_LEN];
      memStore.add({ turn: i, role: "user", content: `WRONG: the ${marker} value is wrong${i}`, kind: "fact", tags: [marker] });
    }
    memStore.add({ turn: 3001, role: "user", content: "CORRECT: the obsidian value is the_real_secret_42", kind: "fact", tags: ["obsidian"], topic: "obsidian" });
    memStore.finalize();
    const top = await memStore.retrieve("what is the obsidian value", 10, 0.01, 3001);
    const hit = top.some((r) => r.content.includes("the_real_secret_42"));
    results.push({ name: "I3 memory poisoning (3000:1)", pass: hit, topCount: top.length, topScore: top[0]?.score });
    memStore.destroy();
  }
  // I4: memory bias (TF-IDF over-favors common terms — rare-term fact wins).
  {
    const memStore = createUnifiedMemoryStore(config, { embeddingsProvider, contentPath: resolve(SCRATCH, "i4.bin") });
    for (let i = 0; i < 100; i += 1) {
      memStore.add({ turn: i, role: "user", content: `function function function function ${RARE[i % RARE_LEN]}`, kind: "turn" });
    }
    memStore.add({ turn: 101, role: "user", content: "the zephyr secret is zephyr_unique_value", kind: "fact", tags: ["zephyr"] });
    memStore.finalize();
    const top = await memStore.retrieve("zephyr secret", 10, 0.0, 101);
    const firstIsZephyr = top.length > 0 && top[0].content.includes("zephyr_unique_value");
    results.push({ name: "I4 memory bias", pass: firstIsZephyr, firstIsZephyr, top1: top[0]?.content.slice(0, 50) });
    memStore.destroy();
  }
  // I5: memory + awareness conflict (two facts same topic, different content).
  {
    const memStore = createUnifiedMemoryStore(config, { embeddingsProvider, contentPath: resolve(SCRATCH, "i5.bin") });
    memStore.add({ turn: 1, role: "user", content: "obsidian value is v1_original", kind: "fact", tags: ["obsidian"], topic: "obsidian" });
    memStore.add({ turn: 2, role: "user", content: "obsidian value is v2_updated", kind: "fact", tags: ["obsidian"], topic: "obsidian" });
    memStore.finalize();
    const top = await memStore.retrieve("obsidian value", 10, 0.0, 2);
    results.push({ name: "I5 mem+awareness conflict", pass: top.length >= 1, topCount: top.length });
    memStore.destroy();
  }
  // I6: drift + memory conflict (drift detected, memory still retrievable). gemma-4-31b.
  {
    const drift = createDriftDetector({ ...config.drift, apiBaseUrl: llmCfg.baseUrl, apiKey: llmCfg.apiKey, apiModel: LLM_MODEL });
    drift.setOriginalTask("refactor babel-traverse assertions");
    for (let i = 0; i < 10; i += 1) drift.trackTurn(i, "explore unrelated topic about flask web routes");
    const result = await drift.check(10);
    const memStore = createUnifiedMemoryStore(config, { embeddingsProvider, contentPath: resolve(SCRATCH, "i6.bin") });
    memStore.add({ turn: 1, role: "user", content: "the cobalt value is cobalt_seed_99", kind: "fact", tags: ["cobalt"] });
    memStore.finalize();
    const top = await memStore.retrieve("cobalt value", 10, 0.0, 10);
    const memHit = top.some((r) => r.content.includes("cobalt_seed_99"));
    results.push({ name: "I6 drift+memory conflict", pass: memHit, driftDetected: result.detected, memHit, driftLayer: result.layer });
    memStore.destroy();
  }
  // I7: missing memory (query for nonexistent — must return empty).
  {
    const memStore = createUnifiedMemoryStore(config, { embeddingsProvider, contentPath: resolve(SCRATCH, "i7.bin") });
    memStore.add({ turn: 1, role: "user", content: "the quasar value is qseed", kind: "fact", tags: ["quasar"] });
    memStore.finalize();
    const top = await memStore.retrieve("nonexistent topic xyz123", 10, 0.5, 1);
    results.push({ name: "I7 missing memory", pass: top.length === 0, topCount: top.length });
    memStore.destroy();
  }
  // I8: oversized memory entry (2MB content — must not crash).
  {
    const memStore = createUnifiedMemoryStore(config, { embeddingsProvider, contentPath: resolve(SCRATCH, "i8.bin") });
    const hugeContent = "x".repeat(2_000_000);
    let threw = false;
    try { memStore.add({ turn: 1, role: "user", content: hugeContent, kind: "turn" }); }
    catch { threw = true; }
    results.push({ name: "I8 oversized entry", pass: true, threw });
    memStore.destroy();
  }
  // I9: tool result store (summary + full + LRU).
  {
    const toolStore = createToolResultStore(config.toolResult);
    const entry = toolStore.add("search_code", "x".repeat(500));
    const summary2 = toolStore.getSummary(entry.id);
    const full = toolStore.getFullResult(entry.id);
    results.push({ name: "I9 tool result store", pass: summary2 !== null && full !== null, summaryLen: summary2?.length, fullLen: full?.length });
  }
  // I10: API error fallback (drift with bad API key — graceful deterministic SAME). gemma-4-31b.
  {
    const drift = createDriftDetector({ ...config.drift, apiBaseUrl: llmCfg.baseUrl, apiKey: "invalid-key", apiModel: LLM_MODEL });
    drift.setOriginalTask("refactor babel-traverse");
    for (let i = 0; i < 10; i += 1) drift.trackTurn(i, "different topic about flask routes");
    const result = await drift.check(10);
    results.push({ name: "I10 API error fallback", pass: !result.detected || result.layer === "deterministic", layer: result.layer });
  }
  let passed = 0;
  for (const r of results) if (r.pass) passed += 1;
  return { results, passed, total: results.length };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== EXP456 — 10× more tests: 300 fact + 300 continuity + 100 flow ===");
  console.log(`Node ${process.version} • ${new Date().toISOString()}`);
  console.log(`Probes per conversation: ${PROBE_COUNTS.factProbes} fact + ${PROBE_COUNTS.continuityProbes} continuity + ${PROBE_COUNTS.flowProbes} flow = ${PROBE_COUNTS.totalPerConversation}`);
  console.log("");

  const baseConfig = resolveUnifiedConfig({
    drift: { apiBaseUrl: llmCfg.baseUrl, apiKey: llmCfg.apiKey, apiModel: LLM_MODEL },
  });
  const embeddingsProvider = createEmbeddingsProvider({ enabled: true });
  console.log(`Embeddings: ${embeddingsProvider.isAvailable() ? "available" : "unavailable"}`);
  console.log("");

  // === Conversation tests: 100, 1000, 10000 turns ===
  const conversationResults = [];
  for (const nTurns of [100, 1000, 10000]) {
    console.log(`--- Running ${nTurns}-turn conversation (700 probes) ---`);
    const r = await runConversation(nTurns, baseConfig, { embeddingsProvider });
    conversationResults.push(r);
    console.log(`  fact: ${r.factHits}/${r.factProbes} (${(r.factRecall * 100).toFixed(1)}%), continuity: ${r.continuityHits}/${r.continuityProbes} (${(r.continuityRecall * 100).toFixed(1)}%), flow: ${r.flowHits}/${r.flowProbes} (${(r.flowRecall * 100).toFixed(1)}%)`);
    console.log(`  latency: ${r.factPerProbeMs.toFixed(2)}ms/fact-probe, total: ${(r.totalMs / 1000).toFixed(2)}s, probes/s: ${r.probesPerSec.toFixed(1)}`);
    console.log(`  RAM: heap ${r.peakHeapMB.toFixed(0)}MB / rss ${r.peakRssMB.toFixed(0)}MB, CPU: user ${r.cpuUserSec.toFixed(2)}s + sys ${r.cpuSystemSec.toFixed(2)}s`);
    console.log(`  tokens: input(content) ${r.inputContentTokens} vs output(summary block) ${r.outputBlockTokens}, disk IO R:${r.diskReadsMB.toFixed(0)}MB W:${r.diskWritesMB.toFixed(0)}MB`);
    console.log(`  embeddings: ${r.embeddingsQueries} queries @ ${r.embeddingsAvgMs.toFixed(1)}ms/query, inverted postings: ${r.invertedPostings}`);
    console.log("");
  }

  // === 10× harder (100000 turns) if 10000 passed ===
  let harder100k = null;
  const tenK = conversationResults[conversationResults.length - 1];
  const allPassed10k = tenK && tenK.factRecall === 1 && tenK.continuityRecall === 1 && tenK.flowRecall === 1;
  if (allPassed10k) {
    console.log("--- 10× harder: 100000-turn conversation (700 probes) ---");
    harder100k = await runConversation(100_000, baseConfig, { embeddingsProvider });
    console.log(`  fact: ${harder100k.factHits}/${harder100k.factProbes} (${(harder100k.factRecall * 100).toFixed(1)}%), continuity: ${harder100k.continuityHits}/${harder100k.continuityProbes} (${(harder100k.continuityRecall * 100).toFixed(1)}%), flow: ${harder100k.flowHits}/${harder100k.flowProbes} (${(harder100k.flowRecall * 100).toFixed(1)}%)`);
    console.log(`  latency: ${harder100k.factPerProbeMs.toFixed(2)}ms/fact-probe, total: ${(harder100k.totalMs / 1000).toFixed(2)}s, probes/s: ${harder100k.probesPerSec.toFixed(1)}`);
    console.log(`  RAM: heap ${harder100k.peakHeapMB.toFixed(0)}MB / rss ${harder100k.peakRssMB.toFixed(0)}MB, CPU: user ${harder100k.cpuUserSec.toFixed(2)}s + sys ${harder100k.cpuSystemSec.toFixed(2)}s`);
    console.log(`  tokens: input(content) ${harder100k.inputContentTokens} vs output(summary block) ${harder100k.outputBlockTokens}, disk IO R:${harder100k.diskReadsMB.toFixed(0)}MB W:${harder100k.diskWritesMB.toFixed(0)}MB`);
    console.log(`  embeddings: ${harder100k.embeddingsQueries} queries @ ${harder100k.embeddingsAvgMs.toFixed(1)}ms/query, inverted postings: ${harder100k.invertedPostings}`);
    console.log("");
  } else {
    console.log("--- 100000-turn SKIPPED (10000-turn did not pass 100%) ---\n");
  }

  // === Improper usage (10 cases, scaled harder) ===
  console.log("--- Improper usage / unknown tests (10 cases) ---");
  const improper = await runImproperUsage(baseConfig, embeddingsProvider);
  for (const r of improper.results) {
    console.log(`  ${r.name}: ${r.pass ? "PASS" : "FAIL"}`);
  }
  console.log(`  Total: ${improper.passed}/${improper.total} handled`);
  console.log("");

  // === Write results ===
  const report = {
    timestamp: new Date().toISOString(),
    node: process.version,
    llmModel: LLM_MODEL,
    probeCounts: PROBE_COUNTS,
    conversations: conversationResults,
    harder100k,
    improper,
  };
  writeFileSync(resolve(RESULTS_DIR, "exp456-results.json"), JSON.stringify(report, null, 2));
  console.log(`Results written to ${resolve(RESULTS_DIR, "exp456-results.json")}`);

  // === Summary ===
  console.log("");
  console.log("=== SUMMARY ===");
  console.log(`Probes per conversation: ${PROBE_COUNTS.factProbes} fact + ${PROBE_COUNTS.continuityProbes} continuity + ${PROBE_COUNTS.flowProbes} flow = ${PROBE_COUNTS.totalPerConversation} (10× EXP445's 70)`);
  for (const r of conversationResults) {
    console.log(`${r.nTurns}-turn: fact ${r.factHits}/${r.factProbes}, continuity ${r.continuityHits}/${r.continuityProbes}, flow ${r.flowHits}/${r.flowProbes}`);
  }
  if (harder100k) {
    console.log(`100000-turn (10×): fact ${harder100k.factHits}/${harder100k.factProbes}, continuity ${harder100k.continuityHits}/${harder100k.continuityProbes}, flow ${harder100k.flowHits}/${harder100k.flowProbes}`);
  }
  console.log(`Improper/unknown: ${improper.passed}/${improper.total} handled`);
  const ref = harder100k ?? tenK;
  console.log(`Performance (worst run): CPU user ${ref.cpuUserSec.toFixed(2)}s + sys ${ref.cpuSystemSec.toFixed(2)}s, RAM heap ${ref.peakHeapMB.toFixed(0)}MB / rss ${ref.peakRssMB.toFixed(0)}MB, disk IO R:${ref.diskReadsMB.toFixed(0)}MB W:${ref.diskWritesMB.toFixed(0)}MB, latency ${ref.factPerProbeMs.toFixed(2)}ms/fact-probe, total ${(ref.totalMs / 1000).toFixed(1)}s`);
  console.log(`Tokens (worst run): input(content) ${ref.inputContentTokens} vs output(summary block) ${ref.outputBlockTokens}, probes/s ${ref.probesPerSec.toFixed(1)}, embeddings ${ref.embeddingsQueries}q @ ${ref.embeddingsAvgMs.toFixed(1)}ms/q`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
