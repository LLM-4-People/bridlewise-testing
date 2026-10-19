import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder, type TimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import {
  isRollbackPlannedRecordKind,
  ROLLBACK_EVENT_DISPOSITION,
  ROLLBACK_RECORD_KIND_DISPOSITION,
  rollbackEventDisposition,
  TIMELINE_EVENT_TYPES,
  TIMELINE_RECORD_KINDS,
} from "../../src/timeline/timeline-types.ts";
import { mkTempDir } from "../support/temp-dir.ts";

/**
 * The record-kind contract between the RECORDERS and the ROLLBACK PLANNER.
 *
 * THE DEFECT THIS GUARDS
 *
 * `recordFileEffect` appends a standalone `event` record; the planner scanned
 * only `terminal` records. So a ledger holding a complete list of file writes
 * planned as "nothing to roll back" — and the failure was invisible, because
 * `recordFileEffect` has no production callers yet. The moment a file-write
 * choke point is wired to it, every recorded write would have been
 * unrecoverable with no error anywhere.
 *
 * WHY A TOTAL MAPPING, NOT A LIST
 *
 * `ROLLBACK_RECORD_KIND_DISPOSITION` gives EVERY record kind a disposition and
 * is declared beside the record-kind registry itself. The `satisfies
 * Record<TimelineRecordKind, ...>` clause makes an unclassified kind a
 * COMPILE error, and the first test below makes it a runtime failure too, so a
 * new record kind cannot silently bypass the planner in either direction.
 */

const VALID_HASH = "a".repeat(64);

function mkRecorder(dir: string): TimelineRecorder {
  const store = createTimelineStore({
    path: join(dir, `rk-${process.pid}-${TIMELINE_RECORD_KINDS.length}.db`),
    ledgerId: "ledger-rk",
  });
  return createTimelineRecorder({ store });
}

test("rollback contract: every timeline record kind has an explicit disposition", () => {
  // Dynamic discovery: the registry is the source, never a copy of it here.
  const classified = Object.keys(ROLLBACK_RECORD_KIND_DISPOSITION).toSorted();
  const registered = [...TIMELINE_RECORD_KINDS].toSorted();
  assert.deepEqual(
    classified,
    registered,
    "every record kind must be explicitly planned or skipped — an unclassified kind would " +
      "silently bypass the rollback planner",
  );
  for (const kind of TIMELINE_RECORD_KINDS) {
    assert.ok(
      ["plan", "skip"].includes(ROLLBACK_RECORD_KIND_DISPOSITION[kind]),
      `record kind "${kind}" has an unknown disposition`,
    );
  }
});

test("rollback contract: the planner and the disposition table agree for every record kind", () => {
  for (const kind of TIMELINE_RECORD_KINDS) {
    assert.equal(
      isRollbackPlannedRecordKind(kind),
      ROLLBACK_RECORD_KIND_DISPOSITION[kind] === "plan",
      `the predicate disagrees with the table for record kind "${kind}"`,
    );
  }
});

test("rollback contract: a recorder that writes an effect writes a PLANNED record kind", () => {
  const dir = mkTempDir("tl-rk-contract-");
  try {
    const rec = mkRecorder(dir);
    rec.recordFileEffect({
      effectId: "fx-1", path: "/test/file.txt", operation: "write",
      preimageDigest: VALID_HASH, postimageDigest: "b".repeat(64),
      description: "write file.txt", correlation: {},
    });
    const recorded = rec.store.query({ eventType: "file-effect" });
    assert.equal(recorded.length, 1, "the file effect was not recorded");
    const kind = recorded[0]!.recordKind;
    assert.ok(
      isRollbackPlannedRecordKind(kind),
      `recordFileEffect writes recordKind "${kind}", which the planner skips — a recorded ` +
        "write would be invisible to rollback",
    );
    // And end-to-end: the planner actually returns it.
    const plan = rec.rollback.plan({ targetSequence: "0" });
    assert.equal(plan.effects.length, 1, "the planner did not surface the recorded file effect");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback contract: an intent alone is skipped so its terminal is not double-counted", () => {
  const dir = mkTempDir("tl-rk-contract-");
  try {
    const rec = mkRecorder(dir);
    rec.beginEffect({
      effectId: "fx-pair", kind: "filesystem",
      actor: { kind: "harness", id: "test" },
      description: "write", intentHash: VALID_HASH,
    });
    rec.endEffect("fx-pair", { outcome: "succeeded", resultHash: VALID_HASH });
    const plan = rec.rollback.plan({ targetSequence: "0" });
    // Two records were written (intent + terminal) but they are ONE effect.
    assert.equal(rec.store.query({ recordKind: "intent" }).length, 1);
    assert.equal(rec.store.query({ recordKind: "terminal" }).length, 1);
    assert.equal(plan.effects.length, 1, "an intent/terminal pair must count as one effect");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback contract: every timeline EVENT TYPE has an explicit rollback disposition", () => {
  // The event-type disposition used to be three partial re-statements in
  // `rollback.ts` (a reversible set, an irreversible-reasons map that silently
  // omitted most types behind a fallback, and a classify chain). A new event
  // type added to `TIMELINE_EVENT_TYPES` got no disposition and fell through
  // to "generic". The total mapping beside the registry makes an undisposed
  // type a compile error; this arm makes it a runtime failure too and pins
  // the invariant that an IRREVERSIBLE type carries its typed reason.
  const disposed = Object.keys(ROLLBACK_EVENT_DISPOSITION).toSorted();
  const registered = [...TIMELINE_EVENT_TYPES].toSorted();
  assert.deepEqual(
    disposed,
    registered,
    "every event type must have an explicit rollback disposition — an undisposed type " +
      "would silently classify as generic with a fallback reason",
  );
  for (const type of TIMELINE_EVENT_TYPES) {
    const d = rollbackEventDisposition(type);
    assert.equal(typeof d.reversible, "boolean", `event type "${type}" has no reversible flag`);
    if (!d.reversible) {
      assert.ok(
        typeof d.reason === "string" && d.reason.length > 0,
        `irreversible event type "${type}" must carry the typed reason the planner reports`,
      );
    }
  }
});
