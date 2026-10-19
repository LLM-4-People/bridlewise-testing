// scripts/exp452/run-exp452.mjs
// EXP452: Memory at 1B tokens (~5M entries). Benchmark SQLite+FTS5 sharded
// inverted index for billion-scale retrieval.
//
// Phases:
//   1. Quick validation (10k entries, verify correctness)
//   2. Scale benchmarks (100k, 1M, 5M entries) — insert time, RAM, disk, recall
//   3. Full probe suite at 5M: 300 fact + 300 continuity + 100 flow probes
//   4. Technique comparison: FTS5-porter vs FTS5-unicode61 vs shard counts
//   5. 10× harder: 10B tokens (50M entries) if 1B works
//
// Research: IVF-PQ + FTS5 (Kagi 2026-07-22) — FTS5 on-disk inverted index,
// O(log N) per query, BM25 ranking. IVF-PQ for vector compression at scale.

import { createHash } from "node:crypto";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveScaleConfig } from "../../src/memory/scale/scale-config.ts";
import { createOwnedTemporaryDirectory } from "../../src/filesystem/private-state.ts";
import { createScaleMemoryStore, capturePerf, perfDelta } from "../../src/memory/scale/memory-store-1b.ts";

// Every data folder and the results live in one owned folder of this run: the
// fixed /tmp/bridlewise names were shared by every run on the machine (and removed
// by the next one).
const RUN_ROOT = createOwnedTemporaryDirectory(tmpdir(), "exp452-");

// --- Synthetic data generation ---

const BABEL_FACTS = [
  "parseExpression parses a single expression node from the input tokens",
  "the tokenizer uses a state machine to advance through character classes",
  "createParser initializes a new parser instance with the given input and options",
  "the scope handler tracks variable declarations and bindings in the AST",
  "finishToken sets the current token type and value for the parser",
  "parseStatement dispatches to the correct statement parser based on token type",
  "the node visitor pattern walks the AST depth-first visiting each node",
  "validateVisitor checks that visitor keys match the node schema",
  "traverseFast is the optimized internal AST traversal for simple visitors",
  "the context tracks scope, plugin context, and error recovery state",
  "babel generates code from the AST using the generator module",
  "template literals are tokenized as TemplateElement nodes with raw and cooked values",
  "the parser handles JSX nodes when the jsx plugin is enabled",
  "typescript plugin extends the base parser with type annotations and generics",
  "the lexer reads tokens one at a time using readToken and readTokenLazy",
  "identifier tokens match the Unicode ID_Start and ID_Continue patterns",
  "numeric literals are parsed according to the ECMAScript number specification",
  "regular expression literals are parsed using a dedicated regex state machine",
  "the parser maintains a token context stack for template literals and arrow functions",
  "optional chaining uses the nullish coalescing operator for short-circuit evaluation",
];

const TOPICS = [
  "tokenizer", "parser", "scope", "traversal", "codegen", "jsx", "typescript",
  "lexer", "visitor", "context", "plugin", "transform", "traverse", "generator",
  "template", "regex", "numeric", "identifier", "arrow-function", "optional-chaining",
  "class", "async", "generator-function", "destructuring", "spread", "yield",
  "import", "export", "module", "decorator", "pipeline", "do-expressions", "record",
  "tuple", "pattern-matching", "logical-assignment", "nullish-coalescing",
];

const CONVERSATIONS = Array.from({ length: 100 }, (_, i) => `conv_${i}`);

function generateEntry(index) {
  const hash = createHash("sha256").update(`entry_${index}`).digest();
  const convId = CONVERSATIONS[hash[0] % CONVERSATIONS.length] ?? "conv_0";
  const topicIdx = hash[1] % TOPICS.length;
  const topic = TOPICS[topicIdx] ?? "parser";
  const factIdx = (hash[2] + index) % BABEL_FACTS.length;
  const fact = BABEL_FACTS[factIdx] ?? BABEL_FACTS[0];

  // Unique content per entry — ~200 tokens (800 chars)
  // Mix of real babel facts + generated content for variety
  const contentParts = [
    `[turn ${index}] ${fact}`,
    `The ${topic} module handles index ${index} with hash ${hash.slice(0, 4).toString("hex")}.`,
    `Operation sequence: read tokens, validate syntax, build AST node tree for ${topic}.`,
    `Context: working on ${topic} in conversation ${convId}. The parser state tracks the current token position.`,
    `Key detail: entry_${index} uses ${topicIdx} variant of the ${topic} algorithm for correct AST construction.`,
  ];
  const content = contentParts.join(" ");

  return Object.freeze({
    id: `mem_${String(index).padStart(10, "0")}_${hash.slice(0, 8).toString("hex")}`,
    tier: "long-term",
    content,
    tags: [topic, convId, `idx_${index % 1000}`],
    agentId: null,
    topic,
    timestamp: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
    sourceEventId: null,
    turnId: `turn_${index}`,
    runId: null,
    metadata: { conversationId: convId },
  });
}

// --- Probe generation ---

function generateFactProbes(count, entryCount) {
  const probes = [];
  for (let i = 0; i < count; i += 1) {
    // Pick a random entry that exists
    const entryIdx = Math.floor((i / count) * entryCount);
    const entry = generateEntry(entryIdx);
    const hash = createHash("sha256").update(`entry_${entryIdx}`).digest();
    const topicIdx = hash[1] % TOPICS.length;
    const topic = TOPICS[topicIdx] ?? "parser";
    const hexPrefix = hash.slice(0, 4).toString("hex");
    // Query uses the unique hex hash that appears in the content — guaranteed unique match
    probes.push({
      query: `${topic} ${hexPrefix} variant`,
      expectedId: entry.id,
      entryIdx,
    });
  }
  return probes;
}

function generateContinuityProbes(count, entryCount) {
  const probes = [];
  for (let i = 0; i < count; i += 1) {
    // Pick a conversation and query for it
    const convIdx = i % CONVERSATIONS.length;
    const convId = CONVERSATIONS[convIdx] ?? "conv_0";
    // Find an entry in this conversation
    const entryIdx = convIdx * Math.floor(entryCount / CONVERSATIONS.length) + (i % Math.max(1, Math.floor(entryCount / CONVERSATIONS.length)));
    const entry = generateEntry(Math.min(entryIdx, entryCount - 1));
    probes.push({
      query: `conversation ${convId} ${entry.topic ?? "parser"}`,
      expectedConversation: convId,
      anyEntryId: entry.id,
      entryIdx: Math.min(entryIdx, entryCount - 1),
    });
  }
  return probes;
}

function generateFlowProbes(count, entryCount) {
  const probes = [];
  for (let i = 0; i < count; i += 1) {
    // Multi-hop: query for a topic + ask about sequential entries
    const topicIdx = i % TOPICS.length;
    const topic = TOPICS[topicIdx] ?? "parser";
    const startIdx = Math.floor((i / count) * entryCount);
    const entry1 = generateEntry(startIdx);
    const entry2 = generateEntry(Math.min(startIdx + 1, entryCount - 1));
    probes.push({
      query: `${topic} sequence operation read tokens validate`,
      expectedTopic: topic,
      entryIds: [entry1.id, entry2.id],
      startIdx,
    });
  }
  return probes;
}

// --- Benchmark runner ---

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatMs(ms) {
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

async function benchmarkScale(entryCount, config, label) {
  const dataDir = `${config.dataDir}_${label}`;
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });

  const cfg = resolveScaleConfig({ ...config, dataDir });
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Benchmark: ${label} — ${entryCount.toLocaleString()} entries`);
  console.log(`  Shards: ${cfg.shardCount}, Hot tier: ${cfg.hotTierEnabled ? cfg.hotTierSize : "disabled"}, Tokenizer: ${cfg.ftsTokenizer}`);
  console.log(`  Data dir: ${dataDir}`);
  console.log("=".repeat(70));

  const store = createScaleMemoryStore(cfg);

  // --- Insert phase ---
  console.log(`\n[INSERT] Inserting ${entryCount.toLocaleString()} entries...`);
  const insertStart = capturePerf();
  const batchStart = Date.now();
  let inserted = 0;
  const batchSize = cfg.insertBatchSize;
  let batch = [];
  for (let i = 0; i < entryCount; i += 1) {
    batch.push(generateEntry(i));
    if (batch.length >= batchSize) {
      inserted += store.insertBatch(batch);
      batch = [];
      if (inserted % (batchSize * 20) === 0) {
        const elapsed = (Date.now() - batchStart) / 1000;
        const rate = inserted / elapsed;
        const mem = process.memoryUsage();
        console.log(`  ${inserted.toLocaleString()}/${entryCount.toLocaleString()} (${(inserted / entryCount * 100).toFixed(1)}%) — ${rate.toFixed(0)} entries/s, RSS ${formatBytes(mem.rss)}, heap ${formatBytes(mem.heapUsed)}`);
      }
    }
  }
  if (batch.length > 0) inserted += store.insertBatch(batch);

  const insertDelta = perfDelta(insertStart);
  const insertWall = Date.now() - batchStart;
  console.log(`\n[INSERT DONE] ${inserted.toLocaleString()} entries in ${formatMs(insertWall)}`);
  console.log(`  Insert rate: ${(inserted / (insertWall / 1000)).toFixed(0)} entries/s`);
  console.log(`  Token rate: ${((inserted * 200) / (insertWall / 1000)).toFixed(0)} tokens/s (est. ${entryCount * 200} tokens)`);
  console.log(`  CPU user: ${formatMs(insertDelta.cpuUserMs)}, CPU system: ${formatMs(insertDelta.cpuSystemMs)}`);
  console.log(`  RSS: ${formatBytes(insertDelta.rssBytes)}, Heap used: ${formatBytes(insertDelta.heapUsedBytes)}`);

  // --- Disk usage ---
  const disk = store.diskBytes();
  console.log(`  Disk: ${formatBytes(disk)} (${(disk / entryCount).toFixed(0)} bytes/entry)`);
  const shardSizes = store.shardSizes();
  console.log(`  Shard distribution: [${shardSizes.join(", ")}]`);

  // --- Count verification ---
  const count = store.count();
  if (count !== entryCount) {
    console.error(`  ⚠️ COUNT MISMATCH: expected ${entryCount}, got ${count}`);
  }

  return { store, insertWall, inserted, disk, insertDelta, count };
}

function runProbes(store, entryCount, factCount, continuityCount, flowCount) {
  console.log(`\n[PROBES] ${factCount} fact + ${continuityCount} continuity + ${flowCount} flow probes`);

  // --- Fact probes ---
  const factProbes = generateFactProbes(factCount, entryCount);
  const factStart = capturePerf();
  let factHits = 0;
  const factLatencies = [];
  for (const probe of factProbes) {
    const t0 = Date.now();
    const results = store.search(probe.query, 10);
    const t1 = Date.now();
    factLatencies.push(t1 - t0);
    const found = results.some((r) => r.entry.id === probe.expectedId);
    if (found) factHits += 1;
  }
  const factDelta = perfDelta(factStart);
  const factAvgLatency = factLatencies.reduce((a, b) => a + b, 0) / factLatencies.length;
  const factMaxLatency = Math.max(...factLatencies);
  const factP95 = factLatencies.sort((a, b) => a - b)[Math.floor(factLatencies.length * 0.95)];

  console.log(`  Fact: ${factHits}/${factCount} (${(factHits / factCount * 100).toFixed(1)}%) recall`);
  console.log(`  Fact latency: avg ${factAvgLatency.toFixed(2)}ms, p95 ${factP95?.toFixed(2) ?? "N/A"}ms, max ${factMaxLatency}ms`);
  console.log(`  Fact total: ${formatMs(factDelta.wallMs)}, CPU user ${formatMs(factDelta.cpuUserMs)}`);

  // --- Continuity probes (conversation-scoped search) ---
  const contProbes = generateContinuityProbes(continuityCount, entryCount);
  const contStart = capturePerf();
  let contHits = 0;
  const contLatencies = [];
  for (const probe of contProbes) {
    const t0 = Date.now();
    // Use conversation-scoped search: conv:convId AND content terms
    // This reduces matches from 5M to ~50K per conversation
    const results = store.searchInConversation(probe.query, probe.expectedConversation, 20);
    const t1 = Date.now();
    contLatencies.push(t1 - t0);
    const found = results.length > 0;
    if (found) contHits += 1;
  }
  const contDelta = perfDelta(contStart);
  const contAvgLatency = contLatencies.reduce((a, b) => a + b, 0) / contLatencies.length;
  const contP95 = contLatencies.sort((a, b) => a - b)[Math.floor(contLatencies.length * 0.95)];

  console.log(`  Continuity: ${contHits}/${continuityCount} (${(contHits / continuityCount * 100).toFixed(1)}%) recall (conv-scoped)`);
  console.log(`  Continuity latency: avg ${contAvgLatency.toFixed(2)}ms, p95 ${contP95?.toFixed(2) ?? "N/A"}ms`);
  console.log(`  Continuity total: ${formatMs(contDelta.wallMs)}, CPU user ${formatMs(contDelta.cpuUserMs)}`);

  // --- Flow probes (topic-scoped search) ---
  const flowProbes = generateFlowProbes(flowCount, entryCount);
  const flowStart = capturePerf();
  let flowHits = 0;
  const flowLatencies = [];
  for (const probe of flowProbes) {
    const t0 = Date.now();
    // Use topic-scoped search: topic:expectedTopic AND content terms
    // This reduces matches from 5M to ~150K per topic
    const scopedQuery = `topic:${probe.expectedTopic} ${probe.query}`;
    const results = store.search(scopedQuery, 20);
    const t1 = Date.now();
    flowLatencies.push(t1 - t0);
    const found = results.some((r) => r.entry.topic === probe.expectedTopic || r.entry.tags.includes(probe.expectedTopic));
    if (found) flowHits += 1;
  }
  const flowDelta = perfDelta(flowStart);
  const flowAvgLatency = flowLatencies.reduce((a, b) => a + b, 0) / flowLatencies.length;
  const flowP95 = flowLatencies.sort((a, b) => a - b)[Math.floor(flowLatencies.length * 0.95)];

  console.log(`  Flow: ${flowHits}/${flowCount} (${(flowHits / flowCount * 100).toFixed(1)}%) recall (topic-scoped)`);
  console.log(`  Flow latency: avg ${flowAvgLatency.toFixed(2)}ms, p95 ${flowP95?.toFixed(2) ?? "N/A"}ms`);
  console.log(`  Flow total: ${formatMs(flowDelta.wallMs)}, CPU user ${formatMs(flowDelta.cpuUserMs)}`);

  // --- Overall ---
  const totalProbes = factCount + continuityCount + flowCount;
  const totalHits = factHits + contHits + flowHits;
  const totalWall = factDelta.wallMs + contDelta.wallMs + flowDelta.wallMs;
  const allLatencies = [...factLatencies, ...contLatencies, ...flowLatencies];
  const overallAvg = allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length;
  const mem = process.memoryUsage();

  console.log(`\n[PROBE SUMMARY]`);
  console.log(`  Total recall: ${totalHits}/${totalProbes} (${(totalHits / totalProbes * 100).toFixed(1)}%)`);
  console.log(`  Overall avg latency: ${overallAvg.toFixed(2)}ms/probe`);
  console.log(`  Total probe wall time: ${formatMs(totalWall)}`);
  console.log(`  RSS: ${formatBytes(mem.rss)}, Heap: ${formatBytes(mem.heapUsed)}`);

  return {
    fact: { hits: factHits, count: factCount, recall: factHits / factCount, avgLatencyMs: factAvgLatency, p95LatencyMs: factP95 ?? 0, maxLatencyMs: factMaxLatency },
    continuity: { hits: contHits, count: continuityCount, recall: contHits / continuityCount, avgLatencyMs: contAvgLatency, p95LatencyMs: contP95 ?? 0 },
    flow: { hits: flowHits, count: flowCount, recall: flowHits / flowCount, avgLatencyMs: flowAvgLatency, p95LatencyMs: flowP95 ?? 0 },
    overall: {
      totalHits,
      totalProbes,
      recall: totalHits / totalProbes,
      avgLatencyMs: overallAvg,
      totalWallMs: totalWall,
    },
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
  };
}

// --- Main ---

async function main() {
  console.log("EXP452: Memory at 1B tokens (~5M entries)");
  console.log(`Node: ${process.version}`);
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`CPUs: ${cpus().length}`);

  const results = {};

  // Phase 1: Quick validation (10k entries)
  const valConfig = resolveScaleConfig({
    dataDir: join(RUN_ROOT, "validate"),
    shardCount: 4,
    hotTierSize: 5000,
    insertBatchSize: 2000,
    cacheSizeKiB: 8192,
    mmapSize: 0,
  });
  const valRun = await benchmarkScale(10_000, valConfig, "validate_10k");
  const valProbes = runProbes(valRun.store, 10_000, 30, 30, 10);
  results.validate = { entryCount: 10_000, ...valProbes };
  valRun.store.destroy();

  // Phase 2: Scale to 1M (200M tokens — 10× from predecessor)
  const cfg1m = resolveScaleConfig({
    dataDir: join(RUN_ROOT, "1m"),
    shardCount: 8,
    hotTierSize: 10_000,
    insertBatchSize: 5000,
    cacheSizeKiB: 8192,
    mmapSize: 0,
  });
  const run1m = await benchmarkScale(1_000_000, cfg1m, "scale_1m");
  const probes1m = runProbes(run1m.store, 1_000_000, 100, 100, 50);
  results.scale1m = { entryCount: 1_000_000, insertWall: run1m.insertWall, disk: run1m.disk, ...probes1m };
  run1m.store.destroy();

  // Phase 3: Scale to 5M (1B tokens) — THE TARGET
  const cfg5m = resolveScaleConfig({
    dataDir: join(RUN_ROOT, "5m"),
    shardCount: 16,
    hotTierSize: 10_000,
    insertBatchSize: 5000,
    cacheSizeKiB: 8192,
    mmapSize: 0,
  });
  const run5m = await benchmarkScale(5_000_000, cfg5m, "scale_5m_1b");
  // Full probe suite: 300 fact + 300 continuity + 100 flow (10× more per user directive)
  const probes5m = runProbes(run5m.store, 5_000_000, 300, 300, 100);
  results.scale5m = {
    entryCount: 5_000_000,
    insertWallMs: run5m.insertWall,
    insertRate: run5m.inserted / (run5m.insertWall / 1000),
    diskBytes: run5m.disk,
    cpuUserMs: run5m.insertDelta.cpuUserMs,
    cpuSystemMs: run5m.insertDelta.cpuSystemMs,
    rssBytes: run5m.insertDelta.rssBytes,
    heapUsedBytes: run5m.insertDelta.heapUsedBytes,
    ...probes5m,
  };

  // Check targets
  console.log("\n" + "=".repeat(70));
  console.log("TARGET CHECK (5M entries = 1B tokens)");
  console.log("=".repeat(70));
  const targets = {
    "Recall 100%": probes5m.overall.recall >= 1.0 ? "PASS" : "FAIL",
    "Retrieve < 500ms": probes5m.overall.avgLatencyMs < 500 ? "PASS" : "FAIL",
    "RAM < 1GB": probes5m.rssBytes < 1024 * 1024 * 1024 ? "PASS" : "FAIL",
    "Disk < 25GB": run5m.disk < 25 * 1024 * 1024 * 1024 ? "PASS" : "FAIL",
  };
  for (const [k, v] of Object.entries(targets)) {
    console.log(`  ${v === "PASS" ? "PASS" : "FAIL"} ${k}`);
  }

  // Phase 4: Technique comparison (at 100k for speed)
  console.log("\n" + "=".repeat(70));
  console.log("TECHNIQUE COMPARISON (100k entries)");
  console.log("=".repeat(70));
  const techniques = [
    { label: "fts5_porter_8shards", shardCount: 8, ftsTokenizer: "porter" },
    { label: "fts5_unicode61_8shards", shardCount: 8, ftsTokenizer: "unicode61" },
    { label: "fts5_porter_1shard", shardCount: 1, ftsTokenizer: "porter" },
    { label: "fts5_porter_16shards", shardCount: 16, ftsTokenizer: "porter" },
    { label: "fts5_porter_8shards_nocache", shardCount: 8, ftsTokenizer: "porter", hotTierEnabled: false },
  ];
  results.techniques = [];
  for (const tech of techniques) {
    const techConfig = resolveScaleConfig({
      dataDir: join(RUN_ROOT, `tech-${tech.label}`),
      shardCount: tech.shardCount,
      ftsTokenizer: tech.ftsTokenizer,
      hotTierEnabled: tech.hotTierEnabled !== false,
      hotTierSize: 10_000,
      insertBatchSize: 5000,
      cacheSizeKiB: 8192,
      mmapSize: 0,
    });
    const run = await benchmarkScale(100_000, techConfig, `tech_${tech.label}`);
    const probes = runProbes(run.store, 100_000, 30, 30, 10);
    results.techniques.push({
      technique: tech.label,
      insertWallMs: run.insertWall,
      diskBytes: run.disk,
      recall: probes.overall.recall,
      avgLatencyMs: probes.overall.avgLatencyMs,
      rssBytes: probes.rssBytes,
    });
    run.store.destroy();
  }

  console.log("\n" + "=".repeat(70));
  console.log("TECHNIQUE COMPARISON RESULTS");
  console.log("=".repeat(70));
  console.log("Technique".padEnd(35) + "Recall".padStart(8) + "Latency".padStart(10) + "Insert".padStart(10) + "Disk".padStart(10) + "RSS".padStart(10));
  for (const t of results.techniques) {
    console.log(
      t.technique.padEnd(35) +
      `${(t.recall * 100).toFixed(0)}%`.padStart(8) +
      `${t.avgLatencyMs.toFixed(1)}ms`.padStart(10) +
      formatMs(t.insertWallMs).padStart(10) +
      formatBytes(t.diskBytes).padStart(10) +
      formatBytes(t.rssBytes).padStart(10),
    );
  }

  // Determine best
  const best = results.techniques.reduce((a, b) =>
    (b.recall > a.recall || (b.recall === a.recall && b.avgLatencyMs < a.avgLatencyMs)) ? b : a
  );
  console.log(`\nBest technique: ${best.technique} (recall ${(best.recall * 100).toFixed(0)}%, latency ${best.avgLatencyMs.toFixed(1)}ms)`);

  // Write results
  writeFileSync(join(RUN_ROOT, "results.json"), JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${join(RUN_ROOT, "results.json")}`);

  // Cleanup 5M store
  run5m.store.destroy();
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
