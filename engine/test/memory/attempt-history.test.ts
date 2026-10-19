import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createAttemptHistory, computeAttemptFingerprint, isStaleContext, type AttemptHistory } from "../../src/memory/attempt-history.ts";
import { createMemoryStore } from "../../src/memory/memory-store.ts";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import {
  ATTEMPT_KINDS,
  ATTEMPT_OUTCOMES,
  createAttemptSearchQuery,
  resolveMemoryConfig,
  type AttemptKind,
  type AttemptOutcome,
} from "../../src/memory/memory-types.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { mkTempDir } from "../support/temp-dir.ts";

function mkHistory(dir: string): { history: AttemptHistory; cleanup: () => void } {
  const timelineStore = createTimelineStore({ path: join(dir, `attempt-${Date.now()}-${Math.random().toString(36).slice(2)}.db`), ledgerId: "l1" });
  const memoryStore = createMemoryStore({ store: timelineStore });
  const history = createAttemptHistory({ memoryStore });
  return { history, cleanup: () => {} };
}

// ========== Record tests ==========

test("attempt-history: records a successful attempt", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    const attempt = history.record({
      kind: "edit",
      intent: "fix bug in writer",
      input: "edit file.ts",
      outcome: "succeeded",
      result: "file updated",
    });
    assert.equal(attempt.kind, "edit");
    assert.equal(attempt.outcome, "succeeded");
    assert.equal(attempt.intent, "fix bug in writer");
    assert.ok(attempt.id.startsWith("att-"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: records a failed attempt with error", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    const attempt = history.record({
      kind: "tool-call",
      intent: "run tests",
      input: "npm test",
      outcome: "failed",
      result: "tests failed",
      error: "timeout",
    });
    assert.equal(attempt.outcome, "failed");
    assert.equal(attempt.error, "timeout");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: records with target", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    const attempt = history.record({
      kind: "edit",
      intent: "fix bug",
      target: "src/file.ts",
      input: "edit",
      outcome: "succeeded",
      result: "done",
    });
    assert.equal(attempt.target, "src/file.ts");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: records without target (null)", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    const attempt = history.record({
      kind: "prompt",
      intent: "ask question",
      input: "what is X?",
      outcome: "succeeded",
      result: "answer",
    });
    assert.equal(attempt.target, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: records with agentId", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    const attempt = history.record({
      kind: "edit",
      intent: "fix",
      input: "edit",
      outcome: "succeeded",
      result: "done",
      agentId: "agent-1",
    });
    assert.equal(attempt.agentId, "agent-1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: records with contextFingerprint", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    const attempt = history.record({
      kind: "edit",
      intent: "fix",
      input: "edit",
      outcome: "succeeded",
      result: "done",
      contextFingerprint: "repo:abc|cfg:def",
    });
    assert.equal(attempt.contextFingerprint, "repo:abc|cfg:def");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: generates contextFingerprint when not provided", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    const attempt = history.record({
      kind: "edit",
      intent: "fix",
      input: "edit",
      outcome: "succeeded",
      result: "done",
      agentId: "a1",
      target: "file.ts",
    });
    assert.ok(attempt.contextFingerprint.length > 0);
    assert.ok(attempt.contextFingerprint.includes("agent:a1"));
    assert.ok(attempt.contextFingerprint.includes("target:file.ts"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: records with metadata", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    const attempt = history.record({
      kind: "test",
      intent: "run tests",
      input: "npm test",
      outcome: "succeeded",
      result: "passed",
      metadata: { duration: "5000", count: "42" },
    });
    assert.equal(attempt.metadata["duration"], "5000");
    assert.equal(attempt.metadata["count"], "42");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: records with custom timestamp", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    const attempt = history.record({
      kind: "edit",
      intent: "fix",
      input: "edit",
      outcome: "succeeded",
      result: "done",
      timestamp: "2026-07-16T12:00:00.000Z",
    });
    assert.equal(attempt.timestamp, "2026-07-16T12:00:00.000Z");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== All attempt kinds and outcomes ==========

test("attempt-history: records all attempt kinds", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    // Read from the owner. Written out by hand this said "all attempt kinds"
    // while being able to name eight of nine forever.
    const kinds: readonly AttemptKind[] = ATTEMPT_KINDS;
    for (const kind of kinds) {
      const attempt = history.record({
        kind,
        intent: `test ${kind}`,
        input: "input",
        outcome: "succeeded",
        result: "result",
      });
      assert.equal(attempt.kind, kind);
    }
    assert.equal(history.count(), kinds.length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: records all attempt outcomes", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    const outcomes: readonly AttemptOutcome[] = ATTEMPT_OUTCOMES;
    for (const outcome of outcomes) {
      const attempt = history.record({
        kind: "edit",
        intent: `test ${outcome}`,
        input: "input",
        outcome,
        result: "result",
      });
      assert.equal(attempt.outcome, outcome);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Validation ==========

test("attempt-history: rejects empty intent", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    assert.throws(() => history.record({
      kind: "edit", intent: "", input: "x", outcome: "succeeded", result: "y",
    }), InputError);
    assert.throws(() => history.record({
      kind: "edit", intent: "", input: "x", outcome: "succeeded", result: "y",
    }), /empty/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: rejects empty input", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    assert.throws(() => history.record({
      kind: "edit", intent: "x", input: "", outcome: "succeeded", result: "y",
    }), InputError);
    assert.throws(() => history.record({
      kind: "edit", intent: "x", input: "", outcome: "succeeded", result: "y",
    }), /empty/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: rejects empty result", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    assert.throws(() => history.record({
      kind: "edit", intent: "x", input: "y", outcome: "succeeded", result: "",
    }), InputError);
    assert.throws(() => history.record({
      kind: "edit", intent: "x", input: "y", outcome: "succeeded", result: "",
    }), /empty/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: rejects invalid kind", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    assert.throws(() => history.record({
      kind: "invalid" as AttemptKind, intent: "x", input: "y", outcome: "succeeded", result: "z",
    }), InputError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: rejects invalid outcome", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    assert.throws(() => history.record({
      kind: "edit", intent: "x", input: "y", outcome: "invalid" as AttemptOutcome, result: "z",
    }), InputError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Search tests ==========

test("attempt-history: search by intent finds matching attempts", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "fix memory leak", input: "i", outcome: "failed", result: "r" });
    history.record({ kind: "edit", intent: "fix race condition", input: "i", outcome: "succeeded", result: "r" });
    const results = history.search(createAttemptSearchQuery({ intent: "memory leak" }));
    assert.equal(results.length, 1);
    assert.ok(results[0]!.attempt.intent.includes("memory leak"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: search by kind filters attempts", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "a", input: "i", outcome: "succeeded", result: "r" });
    history.record({ kind: "test", intent: "b", input: "i", outcome: "succeeded", result: "r" });
    const results = history.search(createAttemptSearchQuery({ kind: "test" }));
    assert.equal(results.length, 1);
    assert.equal(results[0]!.attempt.kind, "test");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: search by outcome filters attempts", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "a", input: "i", outcome: "failed", result: "r" });
    history.record({ kind: "edit", intent: "b", input: "i", outcome: "succeeded", result: "r" });
    const results = history.search(createAttemptSearchQuery({ outcome: "failed" }));
    assert.equal(results.length, 1);
    assert.equal(results[0]!.attempt.outcome, "failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: search by agentId filters attempts", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "a", input: "i", outcome: "succeeded", result: "r", agentId: "a1" });
    history.record({ kind: "edit", intent: "b", input: "i", outcome: "succeeded", result: "r", agentId: "a2" });
    const results = history.search(createAttemptSearchQuery({ agentId: "a1" }));
    assert.equal(results.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: search by target filters attempts", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "a", input: "i", outcome: "succeeded", result: "r", target: "file.ts" });
    history.record({ kind: "edit", intent: "b", input: "i", outcome: "succeeded", result: "r", target: "other.ts" });
    const results = history.search(createAttemptSearchQuery({ target: "file.ts" }));
    assert.equal(results.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: search by text finds in content", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "fix", input: "the error was timeout", outcome: "failed", result: "failed" });
    const results = history.search(createAttemptSearchQuery({ text: "timeout" }));
    assert.equal(results.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: search with combined filters", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "fix", input: "i", outcome: "failed", result: "r", agentId: "a1" });
    history.record({ kind: "test", intent: "fix", input: "i", outcome: "failed", result: "r", agentId: "a1" });
    history.record({ kind: "edit", intent: "fix", input: "i", outcome: "succeeded", result: "r", agentId: "a1" });
    const results = history.search(createAttemptSearchQuery({ kind: "edit", outcome: "failed", agentId: "a1" }));
    assert.equal(results.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: search respects limit", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    for (let i = 0; i < 20; i++) {
      history.record({ kind: "edit", intent: `fix ${i}`, input: "i", outcome: "succeeded", result: "r" });
    }
    const results = history.search(createAttemptSearchQuery({ intent: "fix", limit: 5 }));
    assert.equal(results.length, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== retrieveBeforeRetry tests ==========

test("attempt-history: retrieveBeforeRetry finds similar past attempts", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "fix memory leak in writer", input: "i", outcome: "failed", result: "r", error: "timeout" });
    const results = history.retrieveBeforeRetry({ intent: "fix memory leak in writer" });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.attempt.outcome, "failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: retrieveBeforeRetry with target", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "fix bug", input: "i", outcome: "failed", result: "r", target: "file.ts" });
    history.record({ kind: "edit", intent: "fix bug", input: "i", outcome: "failed", result: "r", target: "other.ts" });
    const results = history.retrieveBeforeRetry({ intent: "fix bug", target: "file.ts" });
    assert.equal(results.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: retrieveBeforeRetry with kind", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "fix bug", input: "i", outcome: "failed", result: "r" });
    history.record({ kind: "test", intent: "fix bug", input: "i", outcome: "succeeded", result: "r" });
    const results = history.retrieveBeforeRetry({ intent: "fix bug", kind: "edit" });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.attempt.kind, "edit");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: retrieveBeforeRetry with no matches returns empty", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "completely different", input: "i", outcome: "succeeded", result: "r" });
    const results = history.retrieveBeforeRetry({ intent: "fix memory leak" });
    assert.equal(results.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: retrieveBeforeRetry respects limit", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    for (let i = 0; i < 10; i++) {
      history.record({ kind: "edit", intent: "same intent", input: `i${i}`, outcome: "failed", result: "r" });
    }
    const results = history.retrieveBeforeRetry({ intent: "same intent", limit: 3 });
    assert.equal(results.length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== hasSimilarFailure tests ==========

test("attempt-history: hasSimilarFailure returns true for similar failure", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "fix memory leak in writer", input: "i", outcome: "failed", result: "r" });
    assert.ok(history.hasSimilarFailure({ intent: "fix memory leak in writer" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: hasSimilarFailure returns false for no match", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "completely different", input: "i", outcome: "failed", result: "r" });
    assert.ok(!history.hasSimilarFailure({ intent: "fix memory leak in writer" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: hasSimilarFailure returns false for only successes", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "fix memory leak", input: "i", outcome: "succeeded", result: "r" });
    assert.ok(!history.hasSimilarFailure({ intent: "fix memory leak" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: hasSimilarFailure with target", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "fix bug", input: "i", outcome: "failed", result: "r", target: "file.ts" });
    assert.ok(history.hasSimilarFailure({ intent: "fix bug", target: "file.ts" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Count tests ==========

test("attempt-history: count returns total attempts", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "a", input: "i", outcome: "succeeded", result: "r" });
    history.record({ kind: "test", intent: "b", input: "i", outcome: "failed", result: "r" });
    assert.equal(history.count(), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: countByOutcome counts specific outcomes", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "a", input: "i", outcome: "succeeded", result: "r" });
    history.record({ kind: "edit", intent: "b", input: "i", outcome: "failed", result: "r" });
    history.record({ kind: "edit", intent: "c", input: "i", outcome: "failed", result: "r" });
    assert.equal(history.countByOutcome("failed"), 2);
    assert.equal(history.countByOutcome("succeeded"), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: countByKind counts specific kinds", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "a", input: "i", outcome: "succeeded", result: "r" });
    history.record({ kind: "test", intent: "b", input: "i", outcome: "succeeded", result: "r" });
    history.record({ kind: "edit", intent: "c", input: "i", outcome: "succeeded", result: "r" });
    assert.equal(history.countByKind("edit"), 2);
    assert.equal(history.countByKind("test"), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Get and all ==========

test("attempt-history: get retrieves by ID", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    const attempt = history.record({ kind: "edit", intent: "findable", input: "i", outcome: "succeeded", result: "r" });
    assert.equal(history.get(attempt.id)!.intent, "findable");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: get returns null for non-existent ID", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    assert.equal(history.get("nonexistent"), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: all returns all attempts", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "a", input: "i", outcome: "succeeded", result: "r" });
    history.record({ kind: "test", intent: "b", input: "i", outcome: "succeeded", result: "r" });
    assert.equal(history.all().length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Recent failures and successes ==========

test("attempt-history: getRecentFailures returns recent failures", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "old failure", input: "i", outcome: "failed", result: "r", timestamp: "2026-07-16T00:00:00.000Z" });
    history.record({ kind: "edit", intent: "new failure", input: "i", outcome: "failed", result: "r", timestamp: "2026-07-16T12:00:00.000Z" });
    history.record({ kind: "edit", intent: "success", input: "i", outcome: "succeeded", result: "r" });
    const failures = history.getRecentFailures(10);
    assert.equal(failures.length, 2);
    assert.equal(failures[0]!.intent, "new failure");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: getRecentSuccesses returns recent successes", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "old success", input: "i", outcome: "succeeded", result: "r", timestamp: "2026-07-16T00:00:00.000Z" });
    history.record({ kind: "edit", intent: "new success", input: "i", outcome: "succeeded", result: "r", timestamp: "2026-07-16T12:00:00.000Z" });
    history.record({ kind: "edit", intent: "failure", input: "i", outcome: "failed", result: "r" });
    const successes = history.getRecentSuccesses(10);
    assert.equal(successes.length, 2);
    assert.equal(successes[0]!.intent, "new success");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: getRecentFailures respects limit", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    for (let i = 0; i < 5; i++) {
      history.record({ kind: "edit", intent: `fail ${i}`, input: "i", outcome: "failed", result: "r", timestamp: `2026-07-16T${i}:00:00.000Z` });
    }
    assert.equal(history.getRecentFailures(2).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Persistence through memory store ==========

test("attempt-history: attempts persist as long-term memory entries", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "test.db"), ledgerId: "l1" });
    const memoryStore = createMemoryStore({ store: timelineStore });
    const history = createAttemptHistory({ memoryStore });
    history.record({ kind: "edit", intent: "persistent attempt", input: "i", outcome: "failed", result: "r" });
    const longTermEntries = memoryStore.longTerm();
    assert.ok(longTermEntries.length >= 1);
    assert.ok(longTermEntries.some(e => e.content.includes("persistent attempt")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Fingerprint helpers ==========

test("attempt-history: computeAttemptFingerprint is deterministic", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    const attempt = history.record({ kind: "edit", intent: "test", input: "i", outcome: "succeeded", result: "r" });
    const fp1 = computeAttemptFingerprint(attempt);
    const fp2 = computeAttemptFingerprint(attempt);
    assert.equal(fp1, fp2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: computeAttemptFingerprint differs for different attempts", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    const a1 = history.record({ kind: "edit", intent: "test1", input: "i", outcome: "succeeded", result: "r" });
    const a2 = history.record({ kind: "edit", intent: "test2", input: "i", outcome: "succeeded", result: "r" });
    assert.notEqual(computeAttemptFingerprint(a1), computeAttemptFingerprint(a2));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: isStaleContext detects change", () => {
  assert.ok(!isStaleContext("abc", "abc"));
  assert.ok(isStaleContext("abc", "def"));
});

test("attempt-history: isStaleContext with empty strings", () => {
  assert.ok(!isStaleContext("", ""));
  assert.ok(isStaleContext("", "abc"));
});

// ========== Prevents repeating failed approach ==========

test("attempt-history: repeated same failure is detectable via retrieveBeforeRetry", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "fix bug X", input: "approach 1", outcome: "failed", result: "didn't work", error: "type error" });
    const beforeRetry = history.retrieveBeforeRetry({ intent: "fix bug X" });
    assert.equal(beforeRetry.length, 1);
    assert.equal(beforeRetry[0]!.attempt.outcome, "failed");
    assert.ok(beforeRetry[0]!.attempt.error !== null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: multiple attempts with same intent are all found", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    history.record({ kind: "edit", intent: "fix bug", input: "approach 1", outcome: "failed", result: "r" });
    history.record({ kind: "edit", intent: "fix bug", input: "approach 2", outcome: "failed", result: "r" });
    history.record({ kind: "edit", intent: "fix bug", input: "approach 3", outcome: "succeeded", result: "r" });
    const results = history.retrieveBeforeRetry({ intent: "fix bug", limit: 10 });
    assert.equal(results.length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: different context fingerprints for different targets", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    const a1 = history.record({ kind: "edit", intent: "fix", input: "i", outcome: "succeeded", result: "r", target: "file1.ts" });
    const a2 = history.record({ kind: "edit", intent: "fix", input: "i", outcome: "succeeded", result: "r", target: "file2.ts" });
    assert.notEqual(a1.contextFingerprint, a2.contextFingerprint);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== createAttemptSearchQuery validation ==========

test("attempt-history: createAttemptSearchQuery validates limit", () => {
  assert.throws(() => createAttemptSearchQuery({ limit: 0 }), InputError);
  assert.throws(() => createAttemptSearchQuery({ limit: -1 }), InputError);
  assert.throws(() => createAttemptSearchQuery({ limit: NaN }), InputError);
});

test("attempt-history: createAttemptSearchQuery default limit is the configured memory search leaf (a2b-design H3: no standalone constant)", () => {
  const query = createAttemptSearchQuery({});
  assert.equal(query.limit, resolveMemoryConfig().searchResultLimit);
});

// ========== Immutability (GAP-12) ==========

test("attempt-history: record returns a frozen attempt", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    const attempt = history.record({
      kind: "edit", intent: "frozen check", input: "i", outcome: "succeeded", result: "r",
    });
    assert.ok(Object.isFrozen(attempt), "recorded attempt must be frozen");
    assert.ok(Object.isFrozen(attempt.metadata), "attempt metadata must be frozen");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: mutating a frozen attempt field throws in strict mode", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    const attempt = history.record({
      kind: "edit", intent: "strict mutation", input: "i", outcome: "succeeded", result: "r",
    });
    assert.throws(
      () => { (attempt as { intent: string }).intent = "tampered"; },
      TypeError,
    );
    assert.equal(attempt.intent, "strict mutation", "field must be unchanged after attempted mutation");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: get returns a frozen attempt by reference", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const { history } = mkHistory(dir);
    const attempt = history.record({
      kind: "edit", intent: "by id", input: "i", outcome: "succeeded", result: "r",
    });
    const retrieved = history.get(attempt.id)!;
    assert.ok(Object.isFrozen(retrieved));
    assert.throws(() => { (retrieved as { outcome: string }).outcome = "failed"; }, TypeError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Process-restart retrieval (FIX 4) ==========

test("attempt-history: retrieveBeforeRetry finds past attempts after a process restart", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const dbPath = join(dir, "restart.db");
    // Session 1: record an attempt, then close the timeline store by
    // dropping the in-memory references (the SQLite DB persists to disk).
    const timelineStore1 = createTimelineStore({ path: dbPath, ledgerId: "l1" });
    const memoryStore1 = createMemoryStore({ store: timelineStore1 });
    const history1 = createAttemptHistory({ memoryStore: memoryStore1 });
    history1.record({
      kind: "edit", intent: "fix memory leak in writer",
      input: "edit writer.ts", outcome: "failed", result: "still leaking", error: "timeout",
    });
    // Close the first timeline store so its SQLite handle is released.
    try { timelineStore1.close(); } catch { /* best-effort */ }

    // Session 2: reopen the SAME timeline DB. The memory store reconstructs
    // its long-term tier from the timeline; the attempt history must
    // reconstruct its in-memory index from those long-term entries so
    // retrieveBeforeRetry returns the past attempt without a fresh record.
    const timelineStore2 = createTimelineStore({ path: dbPath, ledgerId: "l1" });
    const memoryStore2 = createMemoryStore({ store: timelineStore2 });
    const history2 = createAttemptHistory({ memoryStore: memoryStore2 });
    const results = history2.retrieveBeforeRetry({ intent: "fix memory leak in writer" });
    assert.ok(results.length > 0, "retrieveBeforeRetry must return past attempts after a process restart");
    assert.equal(results[0]!.attempt.outcome, "failed");
    assert.equal(results[0]!.attempt.error, "timeout");
    try { timelineStore2.close(); } catch { /* best-effort */ }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attempt-history: count reflects reconstructed attempts after restart", () => {
  const dir = mkTempDir("attempt-test-");
  try {
    const dbPath = join(dir, "restart-count.db");
    const timelineStore1 = createTimelineStore({ path: dbPath, ledgerId: "l1" });
    const memoryStore1 = createMemoryStore({ store: timelineStore1 });
    const history1 = createAttemptHistory({ memoryStore: memoryStore1 });
    history1.record({ kind: "edit", intent: "first", input: "i", outcome: "succeeded", result: "r" });
    history1.record({ kind: "test", intent: "second", input: "i", outcome: "failed", result: "r" });
    try { timelineStore1.close(); } catch { /* best-effort */ }

    const timelineStore2 = createTimelineStore({ path: dbPath, ledgerId: "l1" });
    const memoryStore2 = createMemoryStore({ store: timelineStore2 });
    const history2 = createAttemptHistory({ memoryStore: memoryStore2 });
    assert.equal(history2.count(), 2, "count must reflect attempts reconstructed after restart");
    assert.equal(history2.countByOutcome("failed"), 1);
    assert.equal(history2.countByKind("test"), 1);
    assert.ok(history2.all().length === 2);
    try { timelineStore2.close(); } catch { /* best-effort */ }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
