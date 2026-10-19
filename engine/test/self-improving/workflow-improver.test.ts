/**
 * EXP424 — Workflow Improver HARD test: 10 inefficiencies identified.
 *
 * Per the protocol: "Workflow improver: from the command log, identify 10
 * inefficiencies. Suggest improvements."
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildCommandRecord, CommandLog } from "../../src/self-improving/command-log.ts";
import { analyzeInefficiencies, applyImprovements, SAFE_ACTIONS } from "../../src/self-improving/workflow-improver.ts";
import { loadSelfImprovingConfig } from "../../src/self-improving/config.ts";

const config = loadSelfImprovingConfig({
  minInefficiencyOccurrences: 2,
  duplicateCallThreshold: 3,
  lowCacheHitRateThreshold: 0.30,
});

function rec(
  _id: string,
  command: string,
  type: any,
  args: Record<string, unknown>,
  result: { ok: boolean; output: string; tokens?: number; durationMs?: number },
  extra: { runId?: string; turn?: number; taskIndex?: number; isRetry?: boolean } = {},
) {
  return buildCommandRecord({
    runId: extra.runId ?? "run-1",
    turn: extra.turn ?? 1,
    taskIndex: extra.taskIndex ?? 0,
    command, type, args,
    task: "test-task",
    result: { ok: result.ok, output: result.output, tokens: result.tokens, durationMs: result.durationMs ?? 10 },
    isRetry: extra.isRetry ?? false,
  });
}

test("workflow improver: 10 inefficiency types identified", () => {
  const log = new CommandLog();

  // (1) duplicate_calls — same (command, args) 5 times across 5 runs
  const dupArgs = { query: "find duplicates", viewport: 50 };
  for (let i = 0; i < 5; i++) {
    log.record(rec(`dup-${i}`, "search_code", "search" as any, dupArgs,
      { ok: true, output: "found" }, { runId: `run-${i}` }));
  }
  // (2) missing_cache — implied by duplicates (auto-detected if dup count > threshold)

  // (3) missing_shortcut — 6 calls in one turn
  for (let i = 0; i < 6; i++) {
    log.record(rec(`short-${i}`, "search_code", "search" as any, { query: `q${i}` },
      { ok: true, output: "ok" }, { turn: 2, taskIndex: i }));
  }

  // (4) missing_tool — command with _v2 suffix called many times
  for (let i = 0; i < 15; i++) {
    log.record(rec(`tool-${i}`, "search_code_v2", "tool" as any, { q: `q${i}` },
      { ok: true, output: "ok" }, { runId: `run-${i % 5}` }));
  }

  // (5) bad_tool_choice — recurring misuse failures
  for (let i = 0; i < 3; i++) {
    log.record(rec(`misuse-${i}`, "edit_file", "edit" as any, {},
      { ok: false, output: "wrong tool for the task" }, { runId: `run-${i}` }));
  }

  // (6) context_waste — 3 successful commands with large outputs
  for (let i = 0; i < 3; i++) {
    log.record(rec(`waste-${i}`, "search_code", "search" as any, { query: `big${i}` },
      { ok: true, output: "x".repeat(6000) }));
  }

  // (7) retry_storm — 6 retries
  for (let i = 0; i < 6; i++) {
    log.record(rec(`retry-${i}`, "execute_command", "execute" as any, { cmd: `c${i}` },
      { ok: true, output: "ok" }, { isRetry: true, runId: `run-${i}` }));
  }

  // (8) feedback_loop — same command failing across 3 runs
  const fbArgs = { query: "always fails" };
  for (let i = 0; i < 3; i++) {
    log.record(rec(`fb-${i}`, "search_code", "search" as any, fbArgs,
      { ok: false, output: "regex error" }, { runId: `run-${i}` }));
  }

  // (9) unbatched_calls — 4 same-type calls in one turn
  for (let i = 0; i < 4; i++) {
    log.record(rec(`batch-${i}`, "search_code", "search" as any, { query: `batch${i}` },
      { ok: true, output: "ok" }, { turn: 3, taskIndex: i }));
  }

  // (10) low_cache_hit_rate — many unique search calls (no cache hits)
  for (let i = 0; i < 10; i++) {
    log.record(rec(`unique-search-${i}`, "search_code", "search" as any, { query: `unique${i}` },
      { ok: true, output: "ok" }, { runId: "run-low-cache" }));
  }

  const findings = analyzeInefficiencies(log, config);

  // Verify all 10 inefficiency types are detected.
  const typesFound = new Set(findings.map((f) => f.type));
  const expectedTypes = [
    "duplicate_calls",
    "missing_cache",
    "missing_shortcut",
    "missing_tool",
    "bad_tool_choice",
    "context_waste",
    "retry_storm",
    "feedback_loop",
    "unbatched_calls",
    "low_cache_hit_rate",
  ];
  for (const t of expectedTypes) {
    assert.ok(typesFound.has(t as any), `missing inefficiency type: ${t}`);
  }

  // Each finding should have a suggestion + safe flag.
  for (const f of findings) {
    assert.ok(f.suggestion.length > 0);
    assert.ok(typeof f.safe === "boolean");
    assert.ok(f.evidence.length > 0);
  }
});

test("workflow improver: applyImprovements — safe applied, unsafe recommended", () => {
  const log = new CommandLog();
  // 3 duplicate calls
  for (let i = 0; i < 3; i++) {
    log.record(rec(`d-${i}`, "search_code", "search" as any, { query: "q", viewport: 50 },
      { ok: true, output: "ok" }, { runId: `run-${i}` }));
  }
  // 15 _v2 tool calls (missing_tool, unsafe)
  for (let i = 0; i < 15; i++) {
    log.record(rec(`t-${i}`, "custom_tool_v2", "tool" as any, { x: i },
      { ok: true, output: "ok" }, { runId: `run-${i % 5}` }));
  }
  const findings = analyzeInefficiencies(log, config);
  const { applied, recommended } = applyImprovements(findings, 1, "test");
  // Applied improvements must all have safe=true.
  for (const a of applied) assert.equal(a.safe, true);
  // Recommended improvements must all have safe=false.
  for (const r of recommended) assert.equal(r.safe, false);
  // missing_tool should be in recommended (its action is "add_tool", not whitelisted).
  assert.ok(recommended.some((r) => r.type === "missing_tool"),
    "missing_tool should be recommended (not safe)");
  // duplicate_calls should be in applied (its action "add_cache" is whitelisted).
  assert.ok(applied.some((a) => a.type === "duplicate_calls"),
    "duplicate_calls should be applied (safe)");
});

test("workflow improver: SAFE_ACTIONS whitelist is curated", () => {
  // Verify the whitelisted safe actions (the canonical list).
  assert.ok(SAFE_ACTIONS.has("add_cache"));
  assert.ok(SAFE_ACTIONS.has("add_shortcut"));
  assert.ok(SAFE_ACTIONS.has("batch_calls"));
  assert.ok(SAFE_ACTIONS.has("suggest_tool"));
  assert.ok(SAFE_ACTIONS.has("add_preimage_check"));
  assert.ok(SAFE_ACTIONS.has("add_retry_budget"));
  // Unsafe actions (NOT in the whitelist).
  assert.ok(!SAFE_ACTIONS.has("add_tool"));
  assert.ok(!SAFE_ACTIONS.has("delete_tool"));
  assert.ok(!SAFE_ACTIONS.has("rewrite_module"));
});

test("workflow improver: config thresholds drive behavior", () => {
  const log = new CommandLog();
  // 2 duplicate calls (below minInefficiencyOccurrences=2 by exactly 1 — should NOT flag)
  log.record(rec("d1", "search_code", "search" as any, { q: "x" },
    { ok: true, output: "ok" }, { runId: "r1" }));
  log.record(rec("d2", "search_code", "search" as any, { q: "x" },
    { ok: true, output: "ok" }, { runId: "r2" }));
  // With minInefficiencyOccurrences=3, this should NOT be flagged.
  const cfg = loadSelfImprovingConfig({ minInefficiencyOccurrences: 3 });
  const findings = analyzeInefficiencies(log, cfg);
  assert.ok(!findings.some((f) => f.type === "duplicate_calls"),
    "2 dups should not be flagged with threshold 3");
  // With minInefficiencyOccurrences=2, this SHOULD be flagged.
  const cfg2 = loadSelfImprovingConfig({ minInefficiencyOccurrences: 2 });
  const findings2 = analyzeInefficiencies(log, cfg2);
  assert.ok(findings2.some((f) => f.type === "duplicate_calls"),
    "2 dups should be flagged with threshold 2");
});

// R49-V6: largeOutputChars config field drives context_waste detection
// (previously a hardcoded `5000` inline literal). Proves the
// threshold is config-driven: the same 4000-char output is NOT flagged when
// the threshold is 5000 but IS flagged when the threshold is lowered to 3000.
test("workflow improver: largeOutputChars threshold drives context_waste", () => {
  const log = new CommandLog();
  for (let i = 0; i < 3; i++) {
    log.record(rec(`lo-${i}`, "search_code", "search" as any, { query: `q${i}` },
      { ok: true, output: "x".repeat(4000) }));
  }
  // Default threshold (5000): 4000 chars is NOT large → no context_waste.
  const cfgHigh = loadSelfImprovingConfig({});
  const findingsHigh = analyzeInefficiencies(log, cfgHigh);
  assert.ok(!findingsHigh.some((f) => f.type === "context_waste"),
    "4000-char output should not be flagged when largeOutputChars=5000");
  // Lowered threshold (3000): 4000 chars IS large → context_waste flagged.
  const cfgLow = loadSelfImprovingConfig({ largeOutputChars: 3000 });
  const findingsLow = analyzeInefficiencies(log, cfgLow);
  assert.ok(findingsLow.some((f) => f.type === "context_waste"),
    "4000-char output should be flagged when largeOutputChars=3000");
  // The evidence string carries the configured threshold (not a hardcoded 5000).
  const wasteFinding = findingsLow.find((f) => f.type === "context_waste")!;
  assert.match(wasteFinding.evidence, /> 3000 chars/, "evidence should reflect the configured threshold");
  assert.doesNotMatch(wasteFinding.evidence, /> 5000 chars/, "evidence must not carry the old hardcoded 5000");
});
