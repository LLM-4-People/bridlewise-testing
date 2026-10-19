import { sha256 } from "../../src/kernel/integrity.ts";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SecurityError } from "../../src/kernel/errors.ts";
import { APPEND_ONLY_TRIGGERS, ENFORCED_APPEND_ONLY_TRIGGERS } from "../../src/timeline/timeline-schema.ts";
import { createTimelineStore, type EventLedgerStoragePort } from "../../src/timeline/timeline-store.ts";
import { type TimelineStandaloneEventInput } from "../../src/timeline/timeline-types.ts";
import { mkTempDir } from "../support/temp-dir.ts";
import { openFileTargetsOf } from "../../src/process/process-facts.ts";

/**
 * ── THE RECORD CANNOT BE FALSIFIED, REMOVED OR ALTERED ─────────────────────
 *
 * The rule is enforced by SQLite triggers, which is the lowest layer this
 * process can reach: they hold against the store, against any module that
 * skips it, against a migration written years from now, and against the
 * `sqlite3` prompt. This file proves the enforcement BEHAVIOURALLY — every
 * assertion below issues real SQL against a real ledger file over a connection
 * the product does not own, which is the only way to test a guarantee that is
 * supposed to hold for connections the product does not own.
 *
 * It replaces a test that could not fail. `timeline-store.test.ts` carried
 * `"append-only enforcement prevents UPDATE"`, whose body appended an event,
 * read it back, and asserted the description was what had just been written —
 * it never attempted an UPDATE, so it would have passed with every trigger
 * dropped. That test now delegates here.
 */

function mkEvent(ledgerId: string, eventId: string): TimelineStandaloneEventInput {
  return {
    eventId,
    ledgerId,
    eventType: "turn" as TimelineStandaloneEventInput["eventType"],
    actor: { kind: "harness", id: "runtime" },
    correlation: { runId: "run-1" },
    description: "a recorded event",
    wallTime: "2026-07-27T00:00:00.000Z",
    documents: [{ name: "evidence", contentJson: "{}", contentDigest: sha256("{}") }],
    edges: [{ edgeType: "causal", targetKind: "run", targetId: "run-1" }],
  };
}

/** A ledger file with one full event (row + document + edge) already in it. */
function seededLedger(dir: string): string {
  const path = join(dir, "ledger.db");
  const store: EventLedgerStoragePort = createTimelineStore({ path, ledgerId: "ledger-1" });
  store.appendEvent(mkEvent("ledger-1", "evt-1"));
  store.close();
  return path;
}

/** A raw connection — the attacker's connection. Nothing of ours in the way. */
function raw(path: string): DatabaseSync {
  return new DatabaseSync(path);
}

function abortMessageFor(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

// ========== LAYER 1 — the storage engine refuses ==========

test("append-only: a raw UPDATE against event_log is refused by the engine", () => {
  const dir = mkTempDir("append-only-");
  try {
    const path = seededLedger(dir);
    const db = raw(path);
    const before = db.prepare("SELECT description FROM event_log WHERE event_id = 'evt-1'").get() as { description: string };

    const message = abortMessageFor(() => {
      db.exec("UPDATE event_log SET description = 'a lie' WHERE event_id = 'evt-1'");
    });

    assert.ok(message.includes("append-only"), `the abort must state the rule, got: ${message}`);
    assert.ok(
      message.includes("cannot be altered"),
      `the abort must say what is forbidden in plain words, got: ${message}`,
    );
    const after = db.prepare("SELECT description FROM event_log WHERE event_id = 'evt-1'").get() as { description: string };
    assert.equal(after.description, before.description, "the row must be untouched");
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("append-only: a raw DELETE against event_log is refused by the engine", () => {
  const dir = mkTempDir("append-only-");
  try {
    const path = seededLedger(dir);
    const db = raw(path);

    const message = abortMessageFor(() => {
      db.exec("DELETE FROM event_log WHERE event_id = 'evt-1'");
    });

    assert.ok(message.includes("append-only"), `the abort must state the rule, got: ${message}`);
    assert.ok(
      message.includes("cannot be removed"),
      `the abort must say what is forbidden in plain words, got: ${message}`,
    );
    const count = db.prepare("SELECT COUNT(*) AS c FROM event_log").get() as { c: number };
    assert.equal(count.c, 1, "the event must survive");
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("append-only: an unfiltered DELETE cannot empty the ledger", () => {
  const dir = mkTempDir("append-only-");
  try {
    const path = seededLedger(dir);
    const db = raw(path);
    // The shape someone reaches for when they want the record gone. It must
    // fail on the FIRST row, not delete some prefix and then abort.
    assert.throws(() => { db.exec("DELETE FROM event_log"); });
    const count = db.prepare("SELECT COUNT(*) AS c FROM event_log").get() as { c: number };
    assert.equal(count.c, 1);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("append-only: the evidence and the causal links are protected too", () => {
  const dir = mkTempDir("append-only-");
  try {
    const path = seededLedger(dir);
    const db = raw(path);
    // An event whose evidence can be swapped, or whose causal parent can be
    // repointed, is falsifiable without touching event_log at all.
    for (const statement of [
      "UPDATE event_documents SET content_json = '{\"forged\":true}'",
      "DELETE FROM event_documents",
      "UPDATE event_edges SET target_id = 'some-other-run'",
      "DELETE FROM event_edges",
    ]) {
      const message = abortMessageFor(() => { db.exec(statement); });
      assert.ok(message.includes("append-only"), `${statement} must be refused, got: ${message}`);
    }
    const docs = db.prepare("SELECT COUNT(*) AS c FROM event_documents").get() as { c: number };
    const edges = db.prepare("SELECT COUNT(*) AS c FROM event_edges").get() as { c: number };
    assert.equal(docs.c, 1);
    assert.equal(edges.c, 1);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("append-only: the derived read model stays deletable, because it is derived", () => {
  const dir = mkTempDir("append-only-");
  try {
    const path = seededLedger(dir);
    const store = createTimelineStore({ path, ledgerId: "ledger-1" });
    // `rebuildProjections` deletes every projection row and re-derives it from
    // `event_log`. If the append-only triggers had been put on the read model
    // "for symmetry", this would abort — and the guarantee would have been
    // extended to a cache while protecting nothing that is evidence.
    store.rebuildProjections();
    assert.equal(store.count(), 1);
    assert.equal(store.verifyChain().valid, true);
    store.close();

    const db = raw(path);
    const projected = db.prepare("SELECT COUNT(*) AS c FROM timeline_projection").get() as { c: number };
    assert.equal(projected.c, 1, "the read model must be rebuilt, not merely emptied");
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== The canonical text is the text the engine holds ==========

test("append-only: sqlite stores each trigger exactly as APPEND_ONLY_TRIGGERS declares it", () => {
  const dir = mkTempDir("append-only-");
  try {
    const path = seededLedger(dir);
    const db = raw(path);
    const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all() as
      { name: string; sql: string }[];
    const live = new Map(rows.map((r) => [r.name, r.sql]));

    // Every trigger the store asserts at open: the source tables' six, the
    // sealed originals' two and the seal key check's two (a3-design H3).
    assert.equal(APPEND_ONLY_TRIGGERS.length, 6);
    assert.equal(ENFORCED_APPEND_ONLY_TRIGGERS.length, 10);
    for (const trigger of ENFORCED_APPEND_ONLY_TRIGGERS) {
      // A BYTE equality, deliberately. The startup assertion compares the same
      // two strings with no normaliser in between; if SQLite ever stored the
      // statement differently from the form we author, the assertion would
      // start reporting every ledger as tampered — or, far worse, a
      // normalisation we added to "fix" that would be the hole an altered
      // trigger slips through. This test is what makes that a build failure
      // here rather than a silent behaviour change there.
      assert.equal(live.get(trigger.name), trigger.createSql, `${trigger.name} text must match exactly`);
    }
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("append-only: a ledger created before the plain-words text converges on it", () => {
  const dir = mkTempDir("append-only-");
  try {
    const path = join(dir, "old.db");
    // The text every ledger in the field was created with, reproduced here.
    const old = raw(path);
    old.exec(`
      CREATE TABLE event_log (event_id TEXT PRIMARY KEY);
      CREATE TRIGGER event_log_no_update
      BEFORE UPDATE ON event_log
      BEGIN
        SELECT RAISE(ABORT, 'event_log is append-only: updates are forbidden');
      END;
    `);
    old.close();
    rmSync(path);

    // A real old ledger: created by the store, then rewritten to the old text
    // and its migration-6 row removed, which is exactly the state a ledger
    // written before this change is in.
    const store = createTimelineStore({ path, ledgerId: "ledger-old" });
    store.appendEvent(mkEvent("ledger-old", "evt-old"));
    store.close();

    const surgery = raw(path);
    surgery.exec("DROP TRIGGER event_log_no_update");
    surgery.exec(`CREATE TRIGGER event_log_no_update
BEFORE UPDATE ON event_log
BEGIN
  SELECT RAISE(ABORT, 'event_log is append-only: updates are forbidden');
END`);
    surgery.exec("DELETE FROM schema_migrations WHERE migration_id = 6");
    surgery.close();

    const reopened = createTimelineStore({ path, ledgerId: "ledger-old" });
    assert.equal(reopened.count(), 1, "the events must survive the migration");
    reopened.close();

    const after = raw(path);
    const sql = (after.prepare("SELECT sql FROM sqlite_master WHERE name = 'event_log_no_update'").get() as { sql: string }).sql;
    const expected = APPEND_ONLY_TRIGGERS.find((t) => t.name === "event_log_no_update");
    assert.ok(expected !== undefined);
    assert.equal(sql, expected.createSql, "migration 6 must replace the old text, not skip it");
    after.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== LAYER 2 — absence is loud and immediate ==========

test("append-only: the store REFUSES TO OPEN when a trigger has been dropped", () => {
  const dir = mkTempDir("append-only-");
  try {
    const path = seededLedger(dir);
    const db = raw(path);
    db.exec("DROP TRIGGER event_log_no_delete");
    db.close();

    assert.throws(
      () => createTimelineStore({ path, ledgerId: "ledger-1" }),
      (error: unknown) => {
        assert.ok(error instanceof SecurityError, `expected a SecurityError, got ${String(error)}`);
        assert.equal(error.code, "timeline_append_only_not_enforced");
        assert.ok(error.message.includes("event_log_no_delete"), "the fault must name the trigger");
        assert.ok(error.message.includes("refuses to open"), "the consequence must be stated");
        return true;
      },
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("append-only: the store REFUSES TO OPEN when a trigger has been hollowed out", () => {
  const dir = mkTempDir("append-only-");
  try {
    const path = seededLedger(dir);
    const db = raw(path);
    // The attack an existence check cannot see: right name, right table, right
    // event — and a body that permits everything.
    db.exec("DROP TRIGGER event_log_no_update");
    db.exec(`CREATE TRIGGER event_log_no_update
BEFORE UPDATE ON event_log
BEGIN
  SELECT 1;
END`);
    // Proof the hollowed trigger really is inert, so the assertion below is
    // catching a live hole rather than a cosmetic difference.
    db.exec("UPDATE event_log SET description = 'a lie' WHERE event_id = 'evt-1'");
    const tampered = db.prepare("SELECT description FROM event_log WHERE event_id = 'evt-1'").get() as { description: string };
    assert.equal(tampered.description, "a lie");
    db.close();

    assert.throws(
      () => createTimelineStore({ path, ledgerId: "ledger-1" }),
      (error: unknown) => {
        assert.ok(error instanceof SecurityError);
        assert.equal(error.code, "timeline_append_only_not_enforced");
        assert.ok(error.message.includes("does not match"), "an altered trigger must be reported as altered");
        return true;
      },
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("append-only: every enforced trigger is load-bearing at startup", () => {
  const dir = mkTempDir("append-only-");
  try {
    // Dropping ANY single trigger must refuse the open. A check that only
    // looked at `event_log` would pass most of these.
    for (const trigger of ENFORCED_APPEND_ONLY_TRIGGERS) {
      const path = join(dir, `${trigger.name}.db`);
      const store = createTimelineStore({ path, ledgerId: "ledger-1" });
      store.appendEvent(mkEvent("ledger-1", "evt-1"));
      store.close();

      const db = raw(path);
      db.exec(`DROP TRIGGER ${trigger.name}`);
      db.close();

      assert.throws(
        () => createTimelineStore({ path, ledgerId: "ledger-1" }),
        (error: unknown) => error instanceof SecurityError && error.message.includes(trigger.name),
        `dropping ${trigger.name} must refuse the open`,
      );
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * Count this process's open file descriptors pointing at `path`.
 *
 * COUNTED, NOT INFERRED — and the first version of this test inferred. It
 * refused an open, repaired the ledger, reopened it and asserted that worked,
 * on the theory that a leaked handle would block the second open. It does not:
 * SQLite in WAL mode is perfectly happy with several connections to one file,
 * so that assertion passed with the `db.close()` deleted and proved nothing at
 * all. The leak is a file descriptor, so the test has to count file
 * descriptors.
 */
function openDescriptorsFor(path: string): number {
  return openFileTargetsOf(process.pid).filter((target) => target === path).length;
}

test("append-only: a refused open releases its file descriptor", () => {
  const dir = mkTempDir("append-only-");
  try {
    const path = seededLedger(dir);
    const db = raw(path);
    db.exec("DROP TRIGGER event_edges_no_delete");
    db.close();

    const before = openDescriptorsFor(path);
    // The control: a handle really is counted while it is open, so a zero
    // delta below means "released", not "the instrument cannot see it".
    const probe = raw(path);
    assert.equal(openDescriptorsFor(path), before + 1, "an open connection must be visible to the counter");
    probe.close();
    assert.equal(openDescriptorsFor(path), before, "a closed connection must be gone from the counter");

    assert.throws(() => createTimelineStore({ path, ledgerId: "ledger-1" }));

    assert.equal(
      openDescriptorsFor(path),
      before,
      "the refused open must not leave a descriptor on a ledger it declined to use",
    );

    // And once an operator restores the guarantee, the ledger opens normally.
    const repair = raw(path);
    const trigger = APPEND_ONLY_TRIGGERS.find((t) => t.name === "event_edges_no_delete");
    assert.ok(trigger !== undefined);
    repair.exec(trigger.createSql);
    repair.close();

    const reopened = createTimelineStore({ path, ledgerId: "ledger-1" });
    assert.equal(reopened.count(), 1);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== LAYER 3 — the chain still answers the offline attack ==========

test("append-only: an edit made with the triggers dropped is still VISIBLE to verifyChain", () => {
  const dir = mkTempDir("append-only-");
  try {
    const path = seededLedger(dir);
    const store = createTimelineStore({ path, ledgerId: "ledger-1" });
    store.appendEvent(mkEvent("ledger-1", "evt-2"));
    store.close();

    // The one attack the triggers cannot reach: the file, edited with this
    // process not running. Triggers make alteration UNREACHABLE from inside;
    // the chain hash makes it VISIBLE from outside. Both, because they answer
    // different questions.
    const db = raw(path);
    db.exec("DROP TRIGGER event_log_no_update");
    db.exec("UPDATE event_log SET description = 'a lie' WHERE event_id = 'evt-1'");
    // Put the guarantee back, so the store will open and can be asked.
    const trigger = APPEND_ONLY_TRIGGERS.find((t) => t.name === "event_log_no_update");
    assert.ok(trigger !== undefined);
    db.exec(trigger.createSql);
    db.close();

    const reopened = createTimelineStore({ path, ledgerId: "ledger-1" });
    const verification = reopened.verifyChain();
    assert.equal(verification.valid, false, "the chain must not certify a record that was edited offline");
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
