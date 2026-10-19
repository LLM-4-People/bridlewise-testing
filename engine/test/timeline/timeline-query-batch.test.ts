import { sha256 } from "../../src/kernel/integrity.ts";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { DatabaseSync } from "node:sqlite";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTempDir } from "../support/temp-dir.ts";

/**
 * INVARIANT #55: timeline query must NOT be N+1. The batched plan fetches
 * event rows in ONE query, then all documents and edges in TWO batched
 * `IN (...)` queries — independent of the number of events.
 *
 * This test instruments DatabaseSync.prototype.prepare to count `.all`,
 * `.get`, and `.run` executions during a single query call. For N=100
 * events (under the QUERY_BATCH_SIZE=500 chunk ceiling), the batched plan
 * issues exactly 3 SQL executions (1 main SELECT + 2 batched IN). The old
 * N+1 plan would issue 1 + 3*N = 301 executions.
 */

type Counters = { all: number; get: number; run: number; total: number };

function instrumentDatabase(): { restore: () => void; reset: () => void; counters: Counters } {
  const counters: Counters = { all: 0, get: 0, run: 0, total: 0 };
  const originalPrepare = DatabaseSync.prototype.prepare;
  const originalExec = DatabaseSync.prototype.exec;

  DatabaseSync.prototype.prepare = function patchedPrepare(this: DatabaseSync, ...args: readonly unknown[]) {
    const stmt = originalPrepare.apply(this, args as [string]);
    for (const method of ["all", "get", "run"] as const) {
      const orig = (stmt as unknown as Record<string, (...a: readonly unknown[]) => unknown>)[method];
      if (typeof orig === "function") {
        try {
          Object.defineProperty(stmt, method, {
            value: (...a: readonly unknown[]) => {
              counters[method]++;
              counters.total++;
              return orig.apply(stmt, a as unknown[]);
            },
            configurable: true,
            writable: true,
          });
        } catch {
          // Statement method is non-writable; skip instrumentation.
        }
      }
    }
    return stmt;
  } as typeof DatabaseSync.prototype.prepare;

  // Count exec calls too (doQuery does not use exec, but be thorough).
  DatabaseSync.prototype.exec = function patchedExec(this: DatabaseSync, ...args: readonly unknown[]) {
    counters.total++;
    return originalExec.apply(this, args as [string]);
  } as typeof DatabaseSync.prototype.exec;

  return {
    counters,
    reset: () => { counters.all = 0; counters.get = 0; counters.run = 0; counters.total = 0; },
    restore: () => {
      DatabaseSync.prototype.prepare = originalPrepare;
      DatabaseSync.prototype.exec = originalExec;
    },
  };
}

function buildEventId(i: number): string {
  return `evt-${String(i).padStart(4, "0")}`;
}

test("TimelineQuery batch: querying 100 events uses O(1) SQL executions, not 1+3*N", () => {
  const instrument = instrumentDatabase();
  const dir = createTempDir("tl-batch-100-");
  try {
    const store = createTimelineStore({ path: join(dir, "timeline.db") });
    const N = 100;
    for (let i = 0; i < N; i++) {
      store.appendEvent({
        eventId: buildEventId(i),
        ledgerId: store.ledgerId,
        eventType: "run",
        actor: { kind: "harness", id: "test" },
        description: `event ${i}`,
        wallTime: new Date().toISOString(),
      });
    }
    // Reset counters so we only measure the query call, not construction/inserts.
    instrument.reset();
    const all = store.query({ limit: N + 10 });
    const executions = instrument.counters.total;

    assert.equal(all.length, N, "query must return all 100 events");
    // The old N+1 plan would issue 1 + 3*100 = 301 executions. The batched plan
    // issues 1 (main SELECT) + 2 (batched IN for docs + edges) = 3. We assert
    // the count is well below the N+1 ceiling — specifically <= a small
    // constant, not linear in N.
    assert.ok(
      executions <= 10,
      `query of ${N} events must use O(1) SQL executions (got ${executions}); N+1 plan would use 1+3*${N}=${1 + 3 * N}`,
    );
    assert.ok(
      executions < 1 + 3 * N,
      `query execution count (${executions}) must be far below the N+1 ceiling (${1 + 3 * N})`,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    instrument.restore();
  }
});

test("TimelineQuery batch: 3x events does not produce 3x SQL executions", () => {
  const instrument = instrumentDatabase();
  const dir100 = createTempDir("tl-batch-cmp-100-");
  const dir300 = createTempDir("tl-batch-cmp-300-");
  try {
    function measureQueryExecutions(n: number, dbDir: string): number {
      const store = createTimelineStore({ path: join(dbDir, "timeline.db") });
      for (let i = 0; i < n; i++) {
        store.appendEvent({
          eventId: buildEventId(i),
          ledgerId: store.ledgerId,
          eventType: "run",
          actor: { kind: "harness", id: "test" },
          description: `event ${i}`,
          wallTime: new Date().toISOString(),
        });
      }
      instrument.reset();
      store.query({ limit: n + 10 });
      const count = instrument.counters.total;
      store.close();
      return count;
    }

    const count100 = measureQueryExecutions(100, dir100);
    const count300 = measureQueryExecutions(300, dir300);
    // Both 100 and 300 are under the 500-event chunk ceiling, so both batched
    // plans issue the same number of executions (3). An N+1 plan would show
    // 301 vs 901 — a ~3x increase. We assert the counts are equal (O(1)).
    assert.equal(
      count100,
      count300,
      `querying 300 events must use the same SQL execution count as 100 (got ${count100} vs ${count300}); a linear N+1 plan would show a 3x increase`,
    );
    assert.ok(count100 <= 10, `execution count for 100 events must be small (got ${count100})`);
  } finally {
    rmSync(dir100, { recursive: true, force: true });
    rmSync(dir300, { recursive: true, force: true });
    instrument.restore();
  }
});

test("TimelineQuery batch: events with documents are hydrated in the batched query", () => {
  const instrument = instrumentDatabase();
  const dir = createTempDir("tl-batch-docs-");
  try {
    const store = createTimelineStore({ path: join(dir, "timeline.db") });
    const N = 50;
    for (let i = 0; i < N; i++) {
      store.appendEvent({
        eventId: buildEventId(i),
        ledgerId: store.ledgerId,
        eventType: "message",
        actor: { kind: "harness", id: "test" },
        description: `message ${i}`,
        wallTime: new Date().toISOString(),
        documents: [{ name: "doc", contentJson: `{"i":${i}}`, contentDigest: sha256(`{"i":${i}}`) }],
      });
    }
    instrument.reset();
    const all = store.query({ limit: N + 10 });
    const executions = instrument.counters.total;
    assert.equal(all.length, N);
    // Every event must have its document hydrated — proving batched hydration,
    // not per-row. The batched plan fetches all docs in ONE IN(...) query.
    for (const evt of all) {
      assert.ok(evt.documents.length === 1, `event ${evt.eventId} must have 1 document (batched hydration)`);
    }
    assert.ok(
      executions <= 10,
      `hydrating ${N} events with documents must be O(1) executions (got ${executions}); N+1 would be ~${1 + 3 * N}`,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    instrument.restore();
  }
});
