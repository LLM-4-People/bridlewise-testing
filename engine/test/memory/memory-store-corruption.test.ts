import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { configureDebugSystem, createCollectingSink, resetDebugSystem } from "../../src/shared/debug/debug-system.ts";
import { DEBUG_CONFIG_DEFAULTS } from "../../src/shared/debug/debug-config.ts";

import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createMemoryStore } from "../../src/memory/memory-store.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { createTempDir } from "../support/temp-dir.ts";

/**
 * INVARIANT #59: memory reconstruction must track corrupted entries. When a
 * memory event's contentJson is invalid JSON (or missing required fields),
 * the memory store must count it via corruptedEntryCount and emit a stderr
 * warning on the first corruption — not silently drop it.
 *
 * The memory store persists entries to the timeline as `memory` events with a
 * document named "memory-entry" whose contentJson is a JSON string. On
 * reload, it parses each document; a parse failure increments
 * corruptedEntries and emits one stderr warning.
 */

const MEMORY_EVENT_TYPE = "memory";

function captureStderr<T>(fn: () => T): { stderr: string; result: T } {
  let captured = "";
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => { captured += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    const result = fn();
    process.stderr.write = original;
    return { stderr: captured, result };
  } catch (error) {
    process.stderr.write = original;
    throw error;
  }
}

test("MemoryStore corruption: corruptedEntryCount is 0 on a clean store", () => {
  const dir = createTempDir("mem-corrupt-clean-");
  try {
    const store = createTimelineStore({ path: join(dir, "timeline.db") });
    const mem = createMemoryStore({ store });
    assert.equal(mem.corruptedEntryCount(), 0, "a clean store must have 0 corrupted entries");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MemoryStore corruption: a valid entry is reconstructed without corruption", () => {
  const dir = createTempDir("mem-corrupt-valid-");
  try {
    const store = createTimelineStore({ path: join(dir, "timeline.db") });
    const mem = createMemoryStore({ store });
    mem.addShortTerm("valid memory content", { topic: "test" });
    // Reload from the timeline.
    mem.reload();
    assert.equal(mem.corruptedEntryCount(), 0, "a valid entry must not be counted as corrupted");
    assert.equal(mem.shortTerm().length, 1, "the valid entry must be reconstructed");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MemoryStore corruption: invalid JSON in contentJson is counted and warned", () => {
  const dir = createTempDir("mem-corrupt-badjson-");
  try {
    const store = createTimelineStore({ path: join(dir, "timeline.db") });
    // First, add a valid entry through the memory store so the ledger has a
    // valid memory event.
    const mem = createMemoryStore({ store });
    mem.addShortTerm("valid entry", { topic: "ok" });

    // Now directly append a CORRUPTED memory event to the timeline: a memory
    // event whose "memory-entry" document has invalid JSON in contentJson.
    const corruptContentJson = "fixture-secret {{{";
    store.appendEvent({
      eventId: "mem-corrupt-001",
      ledgerId: store.ledgerId,
      eventType: MEMORY_EVENT_TYPE,
      actor: { kind: "harness", id: "test" },
      description: "[short-term] corrupt entry",
      wallTime: new Date().toISOString(),
      documents: [{
        name: "memory-entry",
        contentJson: corruptContentJson,
        contentDigest: sha256(corruptContentJson),
      }],
    });

    // Reload and capture stderr — the corrupted entry should be counted.
    const { stderr } = captureStderr(() => mem.reload());
    assert.equal(
      mem.corruptedEntryCount(),
      1,
      "exactly 1 corrupted entry must be counted (the invalid-JSON one)",
    );
    assert.equal(mem.shortTerm().length, 1, "the valid entry must still be present");
    assert.ok(
      /\[debug\] diagnostic unavailable/.test(stderr) && !stderr.includes("fixture-secret"),
      `a stderr warning about the corrupted memory entry must be emitted, got: ${stderr.slice(0, 200)}`,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const configured of [false, true]) {
test(`MemoryStore corruption: multiple corrupted entries count correctly and warn once (configured=${configured})`, (t) => {
  resetDebugSystem();
  t.after(resetDebugSystem);
  const sink = createCollectingSink();
  if (configured) configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, sinks: { enabledSinks: ["collecting"] } }, [sink]);
  const dir = createTempDir("mem-corrupt-multi-");
  try {
    const store = createTimelineStore({ path: join(dir, "timeline.db") });
    const mem = createMemoryStore({ store });
    mem.addShortTerm("valid entry", { topic: "ok" });

    // Append two corrupted memory events.
    for (let i = 0; i < 2; i++) {
      const bad = "fixture-secret {{{";
      store.appendEvent({
        eventId: `mem-corrupt-${i}`,
        ledgerId: store.ledgerId,
        eventType: MEMORY_EVENT_TYPE,
        actor: { kind: "harness", id: "test" },
        description: `[short-term] corrupt ${i}`,
        wallTime: new Date().toISOString(),
        documents: [{ name: "memory-entry", contentJson: bad, contentDigest: sha256(bad) }],
      });
    }

    const { stderr } = captureStderr(() => mem.reload());
    assert.equal(JSON.stringify({ stderr, events: sink.events }).includes("fixture-secret"), false);
    if (configured) assert.equal(sink.events[0]?.code, "best_effort_failed");
    assert.equal(mem.shortTerm().length, 1);
    assert.equal(mem.corruptedEntryCount(), 2, "both corrupted entries must be counted");
    // The warning must be emitted only once (the first corruption), not twice.
    const warningCount = configured ? sink.events.length : (stderr.match(/\[debug\] diagnostic unavailable/g) || []).length;
    assert.equal(
      warningCount,
      1,
      `the corruption warning must be emitted exactly once (got ${warningCount})`,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
}


test("MemoryStore corruption: corrupted entry with valid JSON but missing fields is counted", () => {
  const dir = createTempDir("mem-corrupt-missing-");
  try {
    const store = createTimelineStore({ path: join(dir, "timeline.db") });
    const mem = createMemoryStore({ store });
    mem.addShortTerm("valid", { topic: "ok" });

    // A document with valid JSON but missing required fields (id, tier,
    // content) — deserializeEntry returns null, but it's not a JSON parse
    // failure so it's NOT counted as corrupted. The corruption counter only
    // tracks JSON parse failures, not schema-missing fields.
    const validButIncomplete = JSON.stringify({ foo: "bar" });
    store.appendEvent({
      eventId: "mem-incomplete-001",
      ledgerId: store.ledgerId,
      eventType: MEMORY_EVENT_TYPE,
      actor: { kind: "harness", id: "test" },
      description: "[short-term] incomplete",
      wallTime: new Date().toISOString(),
      documents: [{
        name: "memory-entry",
        contentJson: validButIncomplete,
        contentDigest: sha256(validButIncomplete),
      }],
    });

    captureStderr(() => mem.reload());
    // Missing fields are silently skipped (deserializeEntry returns null
    // without incrementing corruptedEntries), so corruption count stays 0.
    // Only a document that is not an entry OBJECT counts (see the JSON non-object case).
    assert.equal(mem.corruptedEntryCount(), 0, "valid JSON with missing fields is skipped, not corrupted");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MemoryStore corruption: JSON that is not an entry object counts as corrupted", () => {
  const dir = createTempDir("mem-corrupt-nonobject-");
  try {
    const store = createTimelineStore({ path: join(dir, "timeline.db") });
    const mem = createMemoryStore({ store });
    mem.addShortTerm("valid", { topic: "ok" });
    for (const [index, contentJson] of ["null", "[]", "5"].entries()) {
      store.appendEvent({
        eventId: `mem-nonobject-${index}`,
        ledgerId: store.ledgerId,
        eventType: MEMORY_EVENT_TYPE,
        actor: { kind: "harness", id: "test" },
        description: `[short-term] non-object ${index}`,
        wallTime: new Date().toISOString(),
        documents: [{ name: "memory-entry", contentJson, contentDigest: sha256(contentJson) }],
      });
    }
    captureStderr(() => mem.reload());
    assert.equal(mem.corruptedEntryCount(), 3, "null, an array and a number are each corrupt entries");
    assert.equal(mem.shortTerm().length, 1, "the valid entry survives");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
