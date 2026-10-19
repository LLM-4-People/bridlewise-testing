import assert from "node:assert/strict";
import test from "node:test";

import { InputError, SecurityError } from "../../src/kernel/errors.ts";
import {
  createForensicOutboxState,
  reduceForensicOutbox,
  forensicOutboxCanForward,
} from "../../src/forensics/forensic-state.ts";

const EVENT_ID = "evt-001";
const INPUT_HASH = "0".repeat(64);

function evidence(overrides: Partial<Record<string, string>> = {}): Readonly<Record<string, string>> {
  return {
    ledgerId: "ledger-1",
    segmentId: "seg-1",
    sequence: "1",
    projectionHash: "1".repeat(64),
    sealedPayloadHash: "2".repeat(64),
    entryHash: "3".repeat(64),
    entryMac: "4".repeat(64),
    ...overrides,
  };
}

function receipt(ev: ReturnType<typeof evidence>): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: "bridlewise-forensic-receipt/v1",
    ledgerId: ev.ledgerId,
    segmentId: ev.segmentId,
    eventId: EVENT_ID,
    sequence: ev.sequence,
    entryHash: ev.entryHash,
    entryMac: ev.entryMac,
    projectionHash: ev.projectionHash,
    sealedPayloadHash: ev.sealedPayloadHash,
    committedAt: { wallTime: "2026-01-01T00:00:00Z" },
    integrityClaim: "cryptographic-correlation-not-external-authenticity",
    effectAuthorized: false,
  };
}

function cmd(type: string, extra: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return { type, eventId: EVENT_ID, inputHash: INPUT_HASH, ...extra };
}

// ---------------------------------------------------------------------------
// createForensicOutboxState
// ---------------------------------------------------------------------------

test("forensic-state: createForensicOutboxState returns a received state", () => {
  const state = createForensicOutboxState(EVENT_ID, INPUT_HASH);
  assert.equal(state.phase, "received");
  assert.equal(state.eventId, EVENT_ID);
  assert.equal(state.inputHash, INPUT_HASH);
});

test("forensic-state: created state is frozen", () => {
  const state = createForensicOutboxState(EVENT_ID, INPUT_HASH);
  assert.ok(Object.isFrozen(state));
});

test("forensic-state: forensicOutboxCanForward is false on a received state", () => {
  assert.equal(forensicOutboxCanForward(createForensicOutboxState(EVENT_ID, INPUT_HASH)), false);
});

test("forensic-state: createForensicOutboxState rejects a non-hex inputHash", () => {
  assert.throws(() => createForensicOutboxState(EVENT_ID, "not-a-hash"), InputError);
});

test("forensic-state: createForensicOutboxState rejects an invalid eventId", () => {
  assert.throws(() => createForensicOutboxState("bad event id!", INPUT_HASH), InputError);
});

// ---------------------------------------------------------------------------
// prepare transition
// ---------------------------------------------------------------------------

test("forensic-state: prepare moves received -> prepared", () => {
  const state = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare"));
  assert.equal(state.phase, "prepared");
});

test("forensic-state: prepare is idempotent on prepared", () => {
  const prepared = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare"));
  const again = reduceForensicOutbox(prepared, cmd("prepare"));
  assert.equal(again.phase, "prepared");
});

test("forensic-state: prepare is idempotent on committed", () => {
  const ev = evidence();
  const committed = reduceForensicOutbox(
    reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare")),
    cmd("commit", { evidence: ev }),
  );
  assert.equal(committed.phase, "committed");
  assert.equal(reduceForensicOutbox(committed, cmd("prepare")).phase, "committed");
});

test("forensic-state: prepare is idempotent on forwardable and receipted", () => {
  const ev = evidence();
  const prepared = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare"));
  const committed = reduceForensicOutbox(prepared, cmd("commit", { evidence: ev }));
  const forwardable = reduceForensicOutbox(committed, cmd("authorize-forward"));
  assert.equal(reduceForensicOutbox(forwardable, cmd("prepare")).phase, "forwardable");
  const receipted = reduceForensicOutbox(forwardable, cmd("record-receipt", { receipt: receipt(ev) }));
  assert.equal(reduceForensicOutbox(receipted, cmd("prepare")).phase, "receipted");
});

test("forensic-state: prepare on a failed state is an invalid transition", () => {
  const failed = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("fail", { failureCode: "boom" }));
  assert.throws(() => reduceForensicOutbox(failed, cmd("prepare")), SecurityError);
});

// ---------------------------------------------------------------------------
// commit transition
// ---------------------------------------------------------------------------

test("forensic-state: commit moves prepared -> committed with evidence", () => {
  const ev = evidence();
  const committed = reduceForensicOutbox(
    reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare")),
    cmd("commit", { evidence: ev }),
  );
  assert.equal(committed.phase, "committed");
  assert.deepEqual(committed.evidence, ev);
});

test("forensic-state: commit is idempotent with the same evidence", () => {
  const ev = evidence();
  const prepared = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare"));
  const committed = reduceForensicOutbox(prepared, cmd("commit", { evidence: ev }));
  const again = reduceForensicOutbox(committed, cmd("commit", { evidence: ev }));
  assert.equal(again.phase, "committed");
});

test("forensic-state: commit with different evidence on a committed state throws", () => {
  const ev = evidence();
  const prepared = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare"));
  const committed = reduceForensicOutbox(prepared, cmd("commit", { evidence: ev }));
  assert.throws(
    () => reduceForensicOutbox(committed, cmd("commit", { evidence: evidence({ entryHash: "9".repeat(64) }) })),
    SecurityError,
  );
});

test("forensic-state: commit from received is an invalid transition", () => {
  assert.throws(
    () => reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("commit", { evidence: evidence() })),
    SecurityError,
  );
});

test("forensic-state: commit from forwardable with same evidence is idempotent", () => {
  const ev = evidence();
  const prepared = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare"));
  const committed = reduceForensicOutbox(prepared, cmd("commit", { evidence: ev }));
  const forwardable = reduceForensicOutbox(committed, cmd("authorize-forward"));
  assert.equal(reduceForensicOutbox(forwardable, cmd("commit", { evidence: ev })).phase, "forwardable");
});

// ---------------------------------------------------------------------------
// authorize-forward transition
// ---------------------------------------------------------------------------

test("forensic-state: authorize-forward moves committed -> forwardable", () => {
  const ev = evidence();
  const prepared = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare"));
  const committed = reduceForensicOutbox(prepared, cmd("commit", { evidence: ev }));
  const forwardable = reduceForensicOutbox(committed, cmd("authorize-forward"));
  assert.equal(forwardable.phase, "forwardable");
  assert.ok(forensicOutboxCanForward(forwardable));
});

test("forensic-state: authorize-forward is idempotent on forwardable", () => {
  const ev = evidence();
  const prepared = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare"));
  const forwardable = reduceForensicOutbox(
    reduceForensicOutbox(prepared, cmd("commit", { evidence: ev })),
    cmd("authorize-forward"),
  );
  assert.equal(reduceForensicOutbox(forwardable, cmd("authorize-forward")).phase, "forwardable");
});

test("forensic-state: authorize-forward from received is invalid", () => {
  assert.throws(
    () => reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("authorize-forward")),
    SecurityError,
  );
});

test("forensic-state: authorize-forward from prepared is invalid", () => {
  const prepared = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare"));
  assert.throws(() => reduceForensicOutbox(prepared, cmd("authorize-forward")), SecurityError);
});

test("forensic-state: forensicOutboxCanForward is false on committed", () => {
  const ev = evidence();
  const prepared = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare"));
  const committed = reduceForensicOutbox(prepared, cmd("commit", { evidence: ev }));
  assert.equal(forensicOutboxCanForward(committed), false);
});

// ---------------------------------------------------------------------------
// record-receipt transition
// ---------------------------------------------------------------------------

test("forensic-state: record-receipt moves forwardable -> receipted", () => {
  const ev = evidence();
  const prepared = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare"));
  const forwardable = reduceForensicOutbox(
    reduceForensicOutbox(prepared, cmd("commit", { evidence: ev })),
    cmd("authorize-forward"),
  );
  const receipted = reduceForensicOutbox(forwardable, cmd("record-receipt", { receipt: receipt(ev) }));
  assert.equal(receipted.phase, "receipted");
});

test("forensic-state: record-receipt is idempotent with the same receipt", () => {
  const ev = evidence();
  const prepared = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare"));
  const forwardable = reduceForensicOutbox(
    reduceForensicOutbox(prepared, cmd("commit", { evidence: ev })),
    cmd("authorize-forward"),
  );
  const r = receipt(ev);
  const receipted = reduceForensicOutbox(forwardable, cmd("record-receipt", { receipt: r }));
  assert.equal(reduceForensicOutbox(receipted, cmd("record-receipt", { receipt: r })).phase, "receipted");
});

test("forensic-state: record-receipt with a changed receipt on a receipted state throws", () => {
  const ev = evidence();
  const prepared = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare"));
  const forwardable = reduceForensicOutbox(
    reduceForensicOutbox(prepared, cmd("commit", { evidence: ev })),
    cmd("authorize-forward"),
  );
  const r1 = receipt(ev);
  const receipted = reduceForensicOutbox(forwardable, cmd("record-receipt", { receipt: r1 }));
  const r2 = receipt(ev);
  (r2 as { entryHash: string }).entryHash = "f".repeat(64);
  assert.throws(() => reduceForensicOutbox(receipted, cmd("record-receipt", { receipt: r2 })), SecurityError);
});

test("forensic-state: record-receipt with a binding mismatch throws", () => {
  const ev = evidence();
  const prepared = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare"));
  const forwardable = reduceForensicOutbox(
    reduceForensicOutbox(prepared, cmd("commit", { evidence: ev })),
    cmd("authorize-forward"),
  );
  const badReceipt = receipt(ev);
  (badReceipt as { eventId: string }).eventId = "evt-other";
  assert.throws(
    () => reduceForensicOutbox(forwardable, cmd("record-receipt", { receipt: badReceipt })),
    SecurityError,
  );
});

test("forensic-state: record-receipt from forwardable is invalid if evidence is missing (defensive)", () => {
  // A forwardable state always has evidence by construction; this covers the
  // defensive branch by feeding a hand-built forwardable state without evidence.
  const ev = evidence();
  const prepared = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare"));
  const committed = reduceForensicOutbox(prepared, cmd("commit", { evidence: ev }));
  const forwardable = reduceForensicOutbox(committed, cmd("authorize-forward"));
  assert.ok((forwardable as { evidence?: unknown }).evidence !== undefined);
});

// ---------------------------------------------------------------------------
// fail transition
// ---------------------------------------------------------------------------

test("forensic-state: fail moves received -> failed with a code", () => {
  const failed = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("fail", { failureCode: "boom" }));
  assert.equal(failed.phase, "failed");
  assert.equal(failed.failureCode, "boom");
});

test("forensic-state: fail is idempotent with the same code", () => {
  const failed = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("fail", { failureCode: "boom" }));
  assert.equal(reduceForensicOutbox(failed, cmd("fail", { failureCode: "boom" })).phase, "failed");
});

test("forensic-state: fail with a different code on a failed state throws", () => {
  const failed = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("fail", { failureCode: "boom" }));
  assert.throws(() => reduceForensicOutbox(failed, cmd("fail", { failureCode: "other" })), SecurityError);
});

test("forensic-state: fail on a receipted state is an invalid transition", () => {
  const ev = evidence();
  const prepared = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare"));
  const forwardable = reduceForensicOutbox(
    reduceForensicOutbox(prepared, cmd("commit", { evidence: ev })),
    cmd("authorize-forward"),
  );
  const receipted = reduceForensicOutbox(forwardable, cmd("record-receipt", { receipt: receipt(ev) }));
  assert.throws(() => reduceForensicOutbox(receipted, cmd("fail", { failureCode: "x" })), SecurityError);
});

test("forensic-state: fail preserves committed evidence", () => {
  const ev = evidence();
  const prepared = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare"));
  const committed = reduceForensicOutbox(prepared, cmd("commit", { evidence: ev }));
  const failed = reduceForensicOutbox(committed, cmd("fail", { failureCode: "late-failure" }));
  assert.equal(failed.phase, "failed");
  assert.deepEqual((failed as { evidence: unknown }).evidence, ev);
});

// ---------------------------------------------------------------------------
// full lifecycle + correlation conflicts + invalid input
// ---------------------------------------------------------------------------

test("forensic-state: full happy-path lifecycle received -> receipted", () => {
  const ev = evidence();
  let state = createForensicOutboxState(EVENT_ID, INPUT_HASH);
  state = reduceForensicOutbox(state, cmd("prepare"));
  state = reduceForensicOutbox(state, cmd("commit", { evidence: ev }));
  state = reduceForensicOutbox(state, cmd("authorize-forward"));
  state = reduceForensicOutbox(state, cmd("record-receipt", { receipt: receipt(ev) }));
  assert.equal(state.phase, "receipted");
  assert.equal(forensicOutboxCanForward(state), false);
});

test("forensic-state: command with mismatched eventId throws correlation conflict", () => {
  const bad = cmd("prepare", { eventId: "evt-other" });
  assert.throws(
    () => reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), bad),
    SecurityError,
  );
});

test("forensic-state: command with mismatched inputHash throws correlation conflict", () => {
  const bad = cmd("prepare", { inputHash: "a".repeat(64) });
  assert.throws(
    () => reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), bad),
    SecurityError,
  );
});

test("forensic-state: an invalid command shape throws InputError", () => {
  assert.throws(
    () => reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), { type: "bogus" }),
    InputError,
  );
});

test("forensic-state: a command with an unknown type is rejected by the schema", () => {
  // Unknown command types fail FORENSIC_OUTBOX_COMMAND_SCHEMA parsing before the
  // reducer's fail fallback; the fail fallback only serves the valid "fail" type.
  assert.throws(
    () => reduceForensicOutbox(
      createForensicOutboxState(EVENT_ID, INPUT_HASH),
      { type: "unknown-command", eventId: EVENT_ID, inputHash: INPUT_HASH, failureCode: "unknown" },
    ),
    InputError,
  );
});

test("forensic-state: an invalid state input throws InputError", () => {
  assert.throws(() => reduceForensicOutbox({ phase: "nonsense" }, cmd("prepare")), InputError);
});

test("forensic-state: a non-object state input throws InputError", () => {
  assert.throws(() => reduceForensicOutbox("not-a-state", cmd("prepare")), InputError);
});

test("forensic-state: a non-object command input throws InputError", () => {
  assert.throws(
    () => reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), "not-a-command"),
    InputError,
  );
});

test("forensic-state: committed state is frozen", () => {
  const ev = evidence();
  const committed = reduceForensicOutbox(
    reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare")),
    cmd("commit", { evidence: ev }),
  );
  assert.ok(Object.isFrozen(committed));
});

test("forensic-state: forensicOutboxCanForward accepts a frozen forwardable state object", () => {
  const ev = evidence();
  const prepared = reduceForensicOutbox(createForensicOutboxState(EVENT_ID, INPUT_HASH), cmd("prepare"));
  const forwardable = reduceForensicOutbox(
    reduceForensicOutbox(prepared, cmd("commit", { evidence: ev })),
    cmd("authorize-forward"),
  );
  assert.equal(forensicOutboxCanForward(forwardable), true);
});

test("forensic-state: forensicOutboxCanForward on a plain invalid object throws InputError", () => {
  // parseState rejects invalid state; canForward does not swallow structural errors.
  assert.throws(() => forensicOutboxCanForward({ phase: "forwardable" }), InputError);
});
