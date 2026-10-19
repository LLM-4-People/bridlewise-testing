/**
 * EXP424 — Success Detector HARD test: 50 successful patterns → best practices.
 *
 * Per the protocol: "Success learner: from 50 successes, extract best practices. Verify."
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildCommandRecord, CommandLog } from "../../src/self-improving/command-log.ts";
import { detectSuccessPatterns, patternToBestPractice } from "../../src/self-improving/success-detector.ts";
import { loadSelfImprovingConfig } from "../../src/self-improving/config.ts";

const config = loadSelfImprovingConfig({ minSuccessCount: 3, minPracticeConfidence: 0.60 });

function rec(
  _id: string,
  command: string,
  type: any,
  args: Record<string, unknown>,
  ok = true,
  output = "ok",
) {
  return buildCommandRecord({
    runId: "run-1", turn: 1, taskIndex: 0, command, type, args,
    task: "test-task",
    result: { ok, output, durationMs: 10 },
  });
}

test("success detector: 50 successes → best practices extracted", () => {
  const log = new CommandLog();
  // Pattern 1: search with viewport=50 — 10 successes
  for (let i = 0; i < 10; i++) {
    log.record(rec(`s1-${i}`, "search_code", "search" as any, { query: `q${i}`, viewport: 50 }));
  }
  // Pattern 2: edit with preimage verification — 10 successes
  for (let i = 0; i < 10; i++) {
    log.record(rec(`s2-${i}`, "edit_file", "edit" as any, { file: `f${i}.ts`, verifyPreimage: true }));
  }
  // Pattern 3: search with language filter — 10 successes
  for (let i = 0; i < 10; i++) {
    log.record(rec(`s3-${i}`, "search_code", "search" as any, { query: `q${i}`, language: "typescript" }));
  }
  // Pattern 4: execute with timeout — 10 successes
  for (let i = 0; i < 10; i++) {
    log.record(rec(`s4-${i}`, "execute_command", "execute" as any, { cmd: `ls ${i}`, timeout: 5000 }));
  }
  // Pattern 5: tool with retries — 10 successes
  for (let i = 0; i < 10; i++) {
    log.record(rec(`s5-${i}`, "tool_call", "tool" as any, { tool: `t${i}`, retries: 3 }));
  }

  const patterns = detectSuccessPatterns(log, config);
  // All 5 patterns should be extracted (each has 10 successes > minSuccessCount=3,
  // confidence=1.0 > minPracticeConfidence=0.60).
  assert.ok(patterns.length >= 5, `expected ≥5 patterns, got ${patterns.length}`);

  // Each pattern should have the correct shape
  for (const p of patterns) {
    assert.ok(p.successCount >= 3, `${p.pattern}: successCount ${p.successCount} < 3`);
    assert.ok(p.confidence >= 0.60, `${p.pattern}: confidence ${p.confidence} < 0.60`);
    assert.ok(p.practice.length > 0);
    assert.ok(p.pattern.length > 0);
  }
});

test("success detector: filters out low-confidence patterns", () => {
  const log = new CommandLog();
  // 5 successes + 5 failures = 50% confidence, below 0.60
  for (let i = 0; i < 5; i++) {
    log.record(rec(`ok-${i}`, "search_code", "search" as any, { viewport: 100, query: `q${i}` }, true));
  }
  for (let i = 0; i < 5; i++) {
    log.record(rec(`fail-${i}`, "search_code", "search" as any, { viewport: 100, query: `q${i}` }, false));
  }
  const patterns = detectSuccessPatterns(log, config);
  assert.equal(patterns.length, 0, "50% confidence should be filtered");
});

test("success detector: filters out low-count patterns", () => {
  const log = new CommandLog();
  // Only 2 successes (< minSuccessCount=3)
  log.record(rec("s1", "search_code", "search" as any, { viewport: 200, query: "q1" }));
  log.record(rec("s2", "search_code", "search" as any, { viewport: 200, query: "q2" }));
  const patterns = detectSuccessPatterns(log, config);
  assert.equal(patterns.length, 0, "2 successes < minSuccessCount=3");
});

test("success detector: patternToBestPractice produces valid BestPractice", () => {
  const log = new CommandLog();
  for (let i = 0; i < 5; i++) {
    log.record(rec(`s-${i}`, "search_code", "search" as any, { viewport: 75, query: `q${i}` }));
  }
  const patterns = detectSuccessPatterns(log, config);
  assert.ok(patterns.length > 0);
  const bp = patternToBestPractice(patterns[0]!, 1, "test");
  assert.ok(bp.id.startsWith("bp-"));
  assert.equal(bp.admittedAt, 1);
  assert.equal(bp.source, "test");
  assert.equal(bp.successCount, patterns[0]!.successCount);
  assert.ok(bp.provenanceHash.length === 64);
});

test("success detector: 50 successes across 5 patterns — verify determinism", () => {
  const log = new CommandLog();
  for (let i = 0; i < 10; i++) {
    log.record(rec(`a-${i}`, "search_code", "search" as any, { viewport: 50, query: `q${i}` }));
    log.record(rec(`b-${i}`, "search_code", "search" as any, { viewport: 100, query: `q${i}` }));
    log.record(rec(`c-${i}`, "edit_file", "edit" as any, { file: `f${i}.ts`, verifyPreimage: true }));
    log.record(rec(`d-${i}`, "execute_command", "execute" as any, { cmd: `ls ${i}`, timeout: 5000 }));
    log.record(rec(`e-${i}`, "tool_call", "tool" as any, { tool: `t${i}`, retries: 3 }));
  }
  // Run twice — same result (deterministic).
  const a = detectSuccessPatterns(log, config);
  const b = detectSuccessPatterns(log, config);
  assert.deepEqual(a.map((p) => p.pattern), b.map((p) => p.pattern));
});
