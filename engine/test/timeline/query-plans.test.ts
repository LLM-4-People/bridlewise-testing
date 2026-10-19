import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import { createTimelineStore, TIMELINE_LINEAGE_STATEMENTS } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import { mkTempDir } from "../support/temp-dir.ts";

/**
 * THE EFFECT LINEAGE NEVER WALKS THE LEDGER (SCALE-CR1 C5).
 *
 * Every paired effect asks the store whether its effect already has an
 * intent and a terminal; boot reconciliation asks which intents have none.
 * On a 10 GB ledger the planner served both lookups from
 * `idx_event_log_ledger_type_seq (ledger_id=?)` — the whole ledger, one id
 * per file — at 147-164 s per lookup, twice per provider call. Migration 11
 * (`timeline-effect-lineage-index-v1`) is the index all three statements
 * seek; this file holds the planner to it on a ledger the PRODUCTION store
 * creates, and holds the cost of a pairing independent of the ledger's size.
 */

const LINEAGE_INDEX = "idx_event_log_effect_lineage";

function planOf(db: DatabaseSync, sql: string): readonly string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((row) => row.detail);
}

function withLedger(fn: (path: string) => void): void {
  const dir = mkTempDir("tl-query-plans-");
  fn(join(dir, "timeline.db"));
}

test("query plans: the intent and terminal lookups seek the lineage index on all three columns", () => {
  withLedger((path) => {
    createTimelineStore({ path, ledgerId: "plans" }).close();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      for (const name of ["intent", "terminal"] as const) {
        const plan = planOf(db, TIMELINE_LINEAGE_STATEMENTS[name]);
        assert.deepEqual(plan, [`SEARCH event_log USING INDEX ${LINEAGE_INDEX} (ledger_id=? AND record_kind=? AND effect_id=?)`], `${name}: ${plan.join(" | ")}`);
      }
    } finally { db.close(); }
  });
});

test("query plans: the pending-intent scan reads only the paired rows (no ledger walk)", () => {
  withLedger((path) => {
    createTimelineStore({ path, ledgerId: "plans" }).close();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const plan = planOf(db, TIMELINE_LINEAGE_STATEMENTS.pendingIntents);
      assert.ok(plan.length > 0);
      for (const step of plan.filter((detail) => detail.startsWith("SEARCH") || detail.startsWith("SCAN"))) {
        assert.match(step, new RegExp(`^SEARCH (i|t) USING (COVERING )?INDEX ${LINEAGE_INDEX} \\(ledger_id=\\? AND record_kind=\\?`), `every step seeks the lineage index: ${plan.join(" | ")}`);
      }
      assert.equal(plan.some((detail) => detail.includes("ledger_type_seq") || detail.includes("ledger_seq") || detail.startsWith("SCAN")), false, plan.join(" | "));
    } finally { db.close(); }
  });
});

test("query plans: the lineage index is partial, over the rows that carry an effect", () => {
  withLedger((path) => {
    createTimelineStore({ path, ledgerId: "plans" }).close();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(LINEAGE_INDEX) as { sql: string } | undefined;
      assert.ok(row !== undefined, "migration 11 created the lineage index");
      assert.match(row.sql, /\(ledger_id, record_kind, effect_id\) WHERE effect_id IS NOT NULL/u);
      assert.ok((db.prepare("SELECT name FROM schema_migrations WHERE name = 'timeline-effect-lineage-index-v1'").get() as { name: string } | undefined) !== undefined);
    } finally { db.close(); }
  });
});

/**
 * The pairing stays a SEEK on a ledger ten times larger — held by the plan the
 * production statements get there, never by a wall-clock ratio (SCALE-CR1-FIX
 * L4: a timing on a shared, loaded machine is not a deterministic test; the
 * plan is the cause a timing would only have sampled). The filler rows only
 * make the ledger large (no chain is verified here), so they are written in
 * one raw statement; every PAIRED effect goes through the production recorder
 * and store, before and after the ledger grew, and none is left pending.
 */
test("query plans: on a ledger ten times larger the pairing still seeks the lineage index, and pairs", () => {
  withLedger((path) => {
    const store = createTimelineStore({ path, ledgerId: "budget" });
    const recorder = createTimelineRecorder({ store });
    const raw = new DatabaseSync(path);
    const zero = "0".repeat(64);
    const fill = (count: number) => {
      const from = Number(store.nextSequence());
      raw.prepare(`WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i + 1 FROM n WHERE i < ?)
        INSERT INTO event_log (event_id, ledger_id, sequence, record_kind, event_type, wall_time, actor_kind, actor_id, description, previous_chain_hash, chain_hash)
        SELECT 'filler-' || i, 'budget', i, 'event', 'engine', '2026-10-01T00:00:00.000Z', 'harness', 'filler', 'filler', ?, ? FROM n`).run(from, from + count - 1, zero, zero);
    };
    const pair = (label: string): void => {
      for (let i = 0; i < 20; i += 1) {
        const effectId = `${label}-${String(i)}`;
        recorder.beginEffect({ effectId, kind: "provider", actor: { kind: "harness", id: "budget" }, description: "pair", intentHash: sha256(effectId) });
        recorder.endEffect(effectId, { outcome: "succeeded", resultHash: sha256(`${effectId}:result`) });
      }
    };
    try {
      fill(20_000);
      pair("small");
      fill(180_000);
      pair("large");
      for (const name of ["intent", "terminal"] as const) {
        assert.deepEqual(planOf(raw, TIMELINE_LINEAGE_STATEMENTS[name]), [`SEARCH event_log USING INDEX ${LINEAGE_INDEX} (ledger_id=? AND record_kind=? AND effect_id=?)`], name);
      }
      assert.equal(planOf(raw, TIMELINE_LINEAGE_STATEMENTS.pendingIntents).some((detail) => detail.startsWith("SCAN") || detail.includes("ledger_seq") || detail.includes("ledger_type_seq")), false);
      assert.deepEqual(recorder.pendingEffects(), []);
    } finally { raw.close(); recorder.close(); }
  });
});
