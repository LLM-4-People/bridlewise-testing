import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createMemoryStore } from "../../src/memory/memory-store.ts";
import { createAttemptHistory } from "../../src/memory/attempt-history.ts";
import { createUnifiedContextManager } from "../../src/memory/unified/unified-context-manager.ts";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTimelineQuery } from "../../src/timeline/timeline-query.ts";
import { resolveUnifiedConfig } from "../../src/memory/unified/unified-config.ts";
import { mkTempDir } from "../support/temp-dir.ts";

// ========== Memory store + timeline persistence ==========

test("integration: memory entries persist to timeline as memory events", () => {
  const dir = mkTempDir("memory-integration-");
  try {
    const dbPath = join(dir, "integration.db");
    const timelineStore = createTimelineStore({ path: dbPath, ledgerId: "l1" });
    const memoryStore = createMemoryStore({ store: timelineStore });
    memoryStore.addShortTerm("short-term fact");
    memoryStore.addLongTerm("long-term fact");

    const query = createTimelineQuery(timelineStore);
    const memoryEvents = query.byEventType("memory");
    assert.equal(memoryEvents.events.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: memory store survives timeline reopen", () => {
  const dir = mkTempDir("memory-integration-");
  try {
    const dbPath = join(dir, "survive.db");

    const timelineStore1 = createTimelineStore({ path: dbPath, ledgerId: "l1" });
    const memoryStore1 = createMemoryStore({ store: timelineStore1 });
    memoryStore1.addShortTerm("persistent entry", { tags: ["survives"] });
    memoryStore1.addLongTerm("durable fact");

    const timelineStore2 = createTimelineStore({ path: dbPath, ledgerId: "l1" });
    const memoryStore2 = createMemoryStore({ store: timelineStore2 });
    assert.equal(memoryStore2.countByTier("short-term"), 1);
    assert.equal(memoryStore2.countByTier("long-term"), 1);
    assert.equal(memoryStore2.shortTerm()[0]!.content, "persistent entry");
    assert.deepEqual([...memoryStore2.shortTerm()[0]!.tags], ["survives"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: memory entries are queryable via timeline query API", () => {
  const dir = mkTempDir("memory-integration-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "test.db"), ledgerId: "l1" });
    const memoryStore = createMemoryStore({ store: timelineStore });
    memoryStore.addShortTerm("queryable", { agentId: "a1", topic: "testing" });

    const query = createTimelineQuery(timelineStore);
    const byAgent = query.byAgent("a1");
    assert.ok(byAgent.events.some(e => e.eventType === "memory"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: multiple memory stores share same timeline", () => {
  const dir = mkTempDir("memory-integration-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "shared.db"), ledgerId: "l1" });

    const store1 = createMemoryStore({ store: timelineStore, agentId: "a1" });
    store1.addShortTerm("from store 1");

    const store2 = createMemoryStore({ store: timelineStore, agentId: "a2" });
    store2.addShortTerm("from store 2");

    assert.equal(store2.countByTier("short-term"), 2);
    store1.reload();
    assert.equal(store1.countByTier("short-term"), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Attempt history + memory store integration ==========

test("integration: attempt history persists through memory store to timeline", () => {
  const dir = mkTempDir("memory-integration-");
  try {
    const dbPath = join(dir, "attempt-int.db");
    const timelineStore = createTimelineStore({ path: dbPath, ledgerId: "l1" });
    const memoryStore = createMemoryStore({ store: timelineStore });
    const history = createAttemptHistory({ memoryStore });

    history.record({
      kind: "edit",
      intent: "fix integration bug",
      input: "edit file.ts",
      outcome: "failed",
      result: "error",
      error: "type mismatch",
    });

    const timelineStore2 = createTimelineStore({ path: dbPath, ledgerId: "l1" });
    const memoryStore2 = createMemoryStore({ store: timelineStore2 });
    const longTerm = memoryStore2.longTerm();
    assert.ok(longTerm.some(e => e.content.includes("fix integration bug")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: attempt history and memory store search work together", () => {
  const dir = mkTempDir("memory-integration-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "test.db"), ledgerId: "l1" });
    const memoryStore = createMemoryStore({ store: timelineStore });
    const history = createAttemptHistory({ memoryStore });

    history.record({ kind: "edit", intent: "fix memory leak", input: "i", outcome: "failed", result: "r" });
    history.record({ kind: "edit", intent: "fix race condition", input: "i", outcome: "succeeded", result: "r" });

    const results = memoryStore.searchByText("memory leak");
    assert.ok(results.length > 0);
    assert.ok(results[0]!.entry.content.includes("memory leak"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Context manager integration (unified) ==========

// ========== Full workflow: record attempt, trim context, retrieve ==========

test("integration: full workflow - record, trim, retrieve", () => {
  const dir = mkTempDir("memory-integration-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "full.db"), ledgerId: "l1" });
    const memoryStore = createMemoryStore({ store: timelineStore });
    const history = createAttemptHistory({ memoryStore });
    const cm = createUnifiedContextManager(resolveUnifiedConfig({
      contextTokenLimit: 200,
      trimThreshold: 0.8,
      recentTurnWindow: 3,
      summaryTokenBudget: 50,
    }));

    // Record some attempts
    history.record({ kind: "edit", intent: "fix bug A", input: "edit a.ts", outcome: "failed", result: "error", error: "type error" });
    history.record({ kind: "edit", intent: "fix bug B", input: "edit b.ts", outcome: "succeeded", result: "ok" });

    // Add turns to context manager
    const first = cm.addTurn({ role: "user", content: "Turn 0. This is conversation content." });
    for (let i = 1; i < 20; i++) {
      cm.addTurn({ role: i % 2 === 0 ? "user" : "assistant", content: `Turn ${i}. This is conversation content.` });
    }

    // Trim context
    const state = cm.trim();
    assert.ok(state.trimmed);

    // A trimmed turn leaves the active window but is still held by its id.
    assert.equal(cm.turns().some((turn) => turn.turnId === first.turnId), false, "the first turn was trimmed from the active window");
    assert.equal(cm.getTurn(first.turnId)?.content, first.content);

    // Check attempt history is searchable
    const beforeRetry = history.retrieveBeforeRetry({ intent: "fix bug A" });
    assert.ok(beforeRetry.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: workflow with promotion", () => {
  const dir = mkTempDir("memory-integration-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "promote.db"), ledgerId: "l1" });
    const memoryStore = createMemoryStore({ store: timelineStore });

    // Add present entries
    memoryStore.addPresent("current task: fix bug");
    memoryStore.addPresent("current constraint: no breaking changes");

    // Promote to short-term
    const promoted = memoryStore.promotePresent();
    assert.equal(promoted.length, 2);
    assert.equal(memoryStore.countByTier("present"), 0);
    assert.equal(memoryStore.countByTier("short-term"), 2);

    // Promote one to long-term
    const firstShort = memoryStore.shortTerm()[0]!;
    const longTerm = memoryStore.promoteToLongTerm(firstShort.id, "Key decision: fix bug without breaking changes");
    assert.ok(longTerm !== null);
    assert.equal(memoryStore.countByTier("long-term"), 1);

    // Verify persistence
    memoryStore.reload();
    assert.equal(memoryStore.countByTier("short-term"), 1);
    assert.equal(memoryStore.countByTier("long-term"), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: search across all tiers", () => {
  const dir = mkTempDir("memory-integration-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "search.db"), ledgerId: "l1" });
    const memoryStore = createMemoryStore({ store: timelineStore });

    memoryStore.addPresent("current error in module");
    memoryStore.addShortTerm("recent error fix");
    memoryStore.addLongTerm("durable fact: error pattern X causes failures");

    const results = memoryStore.searchByText("error");
    assert.equal(results.length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: timeline chain integrity with memory events", () => {
  const dir = mkTempDir("memory-integration-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "chain.db"), ledgerId: "l1" });
    const memoryStore = createMemoryStore({ store: timelineStore });

    for (let i = 0; i < 10; i++) {
      memoryStore.addShortTerm(`fact ${i}`);
    }

    const verification = timelineStore.verifyChain();
    assert.ok(verification.valid);
    assert.equal(verification.verifiedRecords, 10);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: memory events have correct event type", () => {
  const dir = mkTempDir("memory-integration-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "type.db"), ledgerId: "l1" });
    const memoryStore = createMemoryStore({ store: timelineStore });
    memoryStore.addShortTerm("test");

    const query = createTimelineQuery(timelineStore);
    const events = query.byEventType("memory");
    assert.equal(events.events.length, 1);
    assert.equal(events.events[0]!.eventType, "memory");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: memory events have description", () => {
  const dir = mkTempDir("memory-integration-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "desc.db"), ledgerId: "l1" });
    const memoryStore = createMemoryStore({ store: timelineStore });
    memoryStore.addShortTerm("content with topic", { topic: "test-topic" });

    const query = createTimelineQuery(timelineStore);
    const events = query.byEventType("memory");
    assert.ok(events.events[0]!.description.includes("short-term"));
    assert.ok(events.events[0]!.description.includes("test-topic"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: memory events carry documents", () => {
  const dir = mkTempDir("memory-integration-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "docs.db"), ledgerId: "l1" });
    const memoryStore = createMemoryStore({ store: timelineStore });
    memoryStore.addShortTerm("documented content", { tags: ["tag1"] });

    const query = createTimelineQuery(timelineStore);
    const events = query.byEventType("memory");
    assert.equal(events.events[0]!.documents.length, 1);
    assert.equal(events.events[0]!.documents[0]!.name, "memory-entry");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: large memory store with many entries", () => {
  const dir = mkTempDir("memory-integration-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "large.db"), ledgerId: "l1" });
    const memoryStore = createMemoryStore({ store: timelineStore, config: { shortTermTurnLimit: 1000, longTermFactLimit: 1000 } });

    for (let i = 0; i < 100; i++) {
      memoryStore.addShortTerm(`short-term fact ${i}`, { tags: [`tag-${i % 5}`] });
    }
    for (let i = 0; i < 100; i++) {
      memoryStore.addLongTerm(`long-term fact ${i}`);
    }

    assert.equal(memoryStore.countByTier("short-term"), 100);
    assert.equal(memoryStore.countByTier("long-term"), 100);

    const results = memoryStore.searchByText("fact 50");
    assert.ok(results.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: context manager trim then retrieve old content", () => {
  const cfg = resolveUnifiedConfig({
    contextTokenLimit: 50,
    trimThreshold: 0.8,
    recentTurnWindow: 2,
    summaryTokenBudget: 32,
  });
  const cm = createUnifiedContextManager(cfg);

  // Add turns that will be trimmed
  const important = cm.addTurn({ role: "user", content: "Important error about file writer timeout" });
  cm.addTurn({ role: "assistant", content: "Response about the error" });
  for (let i = 0; i < 10; i++) {
    cm.addTurn({ role: "user", content: `Turn ${i}. More content.` });
  }

  // Trim
  cm.trim();

  // The trimmed turn is still held by its id (the unified manager retains trimmed turns).
  assert.equal(cm.turns().some((turn) => turn.turnId === important.turnId), false, "the turn was trimmed from the active window");
  assert.equal(cm.getTurn(important.turnId)?.content, "Important error about file writer timeout");
});

test("integration: attempt history prevents repeated failure detection", () => {
  const dir = mkTempDir("memory-integration-");
  try {
    const timelineStore = createTimelineStore({ path: join(dir, "prevent.db"), ledgerId: "l1" });
    const memoryStore = createMemoryStore({ store: timelineStore });
    const history = createAttemptHistory({ memoryStore });

    // Simulate a failed attempt
    history.record({
      kind: "edit",
      intent: "fix bug by adding null check",
      input: "if (x !== null) { ... }",
      outcome: "failed",
      result: "tests still fail",
      error: "null is not the only issue",
    });

    // Before retrying the same approach, check for similar failures
    const hasFailed = history.hasSimilarFailure({ intent: "fix bug by adding null check" });
    assert.ok(hasFailed, "Should detect that this approach was tried and failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: full session simulation", () => {
  const dir = mkTempDir("memory-integration-");
  try {
    const dbPath = join(dir, "session.db");
    const timelineStore = createTimelineStore({ path: dbPath, ledgerId: "l1" });
    const memoryStore = createMemoryStore({ store: timelineStore });
    const history = createAttemptHistory({ memoryStore });
    const cm = createUnifiedContextManager(resolveUnifiedConfig({
      contextTokenLimit: 200,
      trimThreshold: 0.8,
      recentTurnWindow: 5,
      summaryTokenBudget: 100,
    }));

    // Simulate a multi-turn conversation
    cm.addTurn({ role: "system", content: "You are a coding assistant.", pinned: true });
    cm.addTurn({ role: "user", content: "Fix the memory leak in the writer module." });
    cm.addTurn({ role: "assistant", content: "I'll look into the writer module." });

    // Record an attempt
    history.record({
      kind: "edit",
      intent: "fix memory leak in writer",
      input: "add cleanup in finally block",
      target: "src/writer.ts",
      outcome: "failed",
      result: "leak still present",
      error: "cleanup not sufficient",
    });

    // Store a fact in long-term memory
    memoryStore.addLongTerm("Memory leak in writer module is caused by unclosed stream handles", {
      tags: ["bug", "memory-leak"],
      topic: "writer-module",
    });

    // Add more turns to trigger trimming
    for (let i = 0; i < 30; i++) {
      cm.addTurn({ role: i % 2 === 0 ? "user" : "assistant", content: `Turn ${i}. Discussion about the fix.` });
    }

    // Trim context
    const state = cm.trim();
    assert.ok(state.trimmed);

    // Verify system prompt (pinned) is preserved
    assert.ok(state.turns.some(t => t.pinned));

    // Before retry, check attempt history
    const beforeRetry = history.retrieveBeforeRetry({ intent: "fix memory leak in writer" });
    assert.ok(beforeRetry.length > 0);
    assert.equal(beforeRetry[0]!.attempt.outcome, "failed");

    // Verify memory persists
    memoryStore.reload();
    assert.ok(memoryStore.countByTier("long-term") > 0);
    const facts = memoryStore.searchByText("memory leak");
    assert.ok(facts.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
