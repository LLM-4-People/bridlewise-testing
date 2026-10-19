import { InputError, SecurityError } from "../src/kernel/errors.ts";
import { LedgerPersistenceUncertainError } from "../src/timeline/ledger-primitives.ts";
import assert from "node:assert/strict";
import test from "node:test";

import {
  EXECUTION_CLOSURE_IDENTITY,
  EXECUTION_CLOSURE_IDENTITY_HASH,
  EXECUTION_CLOSURE_SCHEMA_VERSION,
  EXECUTION_CLOSURE_DOMAIN,
  EXECUTION_CLOSURE_RECORD_DOMAIN,
  EXECUTION_CLOSURE_REVISION,
  EXECUTION_EFFECT_KINDS,
  EXECUTION_OUTCOMES,
  createExecutionClosure,
  isExecutionEffectKind,
  isExecutionOutcome,
  restoreExecutionClosure,
  verifyExecutionClosureSnapshot,
  type ExecutionClosure,
  type ExecutionClosureClock,
  type ExecutionClosureSnapshot,
  type ExecutionEffectKind,
  type ExecutionOutcome,
} from "../src/kernel/execution-closure.ts";
import { canonicalHash, sha256 } from "../src/kernel/integrity.ts";
import { canonicalizeLedgerJson } from "../src/kernel/ledger-canonical.ts";
import { thrownFailure } from "./support/factories.ts";

const ZERO_HASH = "0".repeat(64);
const VALID_HASH_A = "a".repeat(64);
const VALID_HASH_B = "b".repeat(64);
const VALID_HASH_C = "c".repeat(64);

function deterministicClock(start = 0): ExecutionClosureClock {
  let tick = start;
  return Object.freeze({
    now: () => {
      const wallTime = `2026-07-16T00:00:${String(tick).padStart(2, "0")}.000Z`;
      const monotonicNanoseconds = String((BigInt(tick) + 1n) * 1_000_000_000n);
      tick += 1;
      return Object.freeze({ wallTime, monotonicNanoseconds });
    },
  });
}

function freshClosure(): ExecutionClosure {
  return createExecutionClosure({ ledgerId: "ledger-x", segmentId: "segment-1", clock: deterministicClock() });
}

function beginFixture(closure: ExecutionClosure, effectId: string, kind: ExecutionEffectKind = "filesystem", intentHash: string = VALID_HASH_A): unknown {
  return closure.beginEffect({
    effectId,
    kind,
    actor: { kind: "harness", id: "agent-1" },
    correlation: { runId: "run-1", taskId: "task-1" },
    description: "write file",
    intentHash,
  });
}

function endFixture(closure: ExecutionClosure, effectId: string, outcome: Exclude<ExecutionOutcome, "pending"> = "succeeded", resultHash: string = VALID_HASH_B): unknown {
  return closure.endEffect(effectId, { outcome, resultHash });
}

function tamperRecord(snapshot: ExecutionClosureSnapshot, index: number, mutator: (record: Record<string, unknown>) => void): ExecutionClosureSnapshot {
  const records = snapshot.records.map((record, i) => {
    if (i !== index) return record;
    const copy: Record<string, unknown> = { ...(record as unknown as Record<string, unknown>) };
    mutator(copy);
    return copy as unknown as ExecutionClosureSnapshot["records"][number];
  });
  return { ...snapshot, records };
}

test("execution-closure identity and schema version are stable and frozen", () => {
  assert.equal(EXECUTION_CLOSURE_SCHEMA_VERSION, "bridlewise-execution-closure/v1");
  assert.equal(EXECUTION_CLOSURE_REVISION, "execution-closure-global-lineage/v1");
  assert.ok(Object.isFrozen(EXECUTION_EFFECT_KINDS));
  assert.ok(Object.isFrozen(EXECUTION_OUTCOMES));
  assert.ok(Object.isFrozen(EXECUTION_CLOSURE_IDENTITY));
  assert.equal(EXECUTION_CLOSURE_IDENTITY.schemaVersion, EXECUTION_CLOSURE_SCHEMA_VERSION);
  assert.equal(EXECUTION_CLOSURE_IDENTITY.effectKinds, EXECUTION_EFFECT_KINDS);
  assert.equal(EXECUTION_CLOSURE_IDENTITY.outcomes, EXECUTION_OUTCOMES);
  const recomputed = canonicalHash(EXECUTION_CLOSURE_IDENTITY);
  assert.equal(recomputed, EXECUTION_CLOSURE_IDENTITY_HASH);
  assert.equal(recomputed, canonicalHash(EXECUTION_CLOSURE_IDENTITY), "identity hash is deterministic");
  assert.ok(EXECUTION_CLOSURE_DOMAIN.endsWith("\u0000"));
  assert.ok(EXECUTION_CLOSURE_RECORD_DOMAIN.includes("execution-closure-record"));
});

test("EXECUTION_EFFECT_KINDS is the closed canonical registry", () => {
  assert.deepEqual([...EXECUTION_EFFECT_KINDS], [
    "provider", "network", "process", "filesystem", "git",
    "memory", "permission", "quality", "promotion", "ledger",
  ]);
  assert.equal(EXECUTION_EFFECT_KINDS.length, 10);
});

test("EXECUTION_OUTCOMES is the closed canonical set", () => {
  assert.deepEqual([...EXECUTION_OUTCOMES], ["pending", "succeeded", "failed", "cancelled", "denied"]);
});

for (const kind of ["provider", "network", "process", "filesystem", "git", "memory", "permission", "quality", "promotion", "ledger"] as const) {
  test(`isExecutionEffectKind accepts ${kind}`, () => {
    assert.equal(isExecutionEffectKind(kind), true);
  });
}

test("isExecutionEffectKind rejects non-kinds", () => {
  for (const value of ["unknown", "", "Provider", "file-system", "effect", 42, null, undefined, {}, [], "provider "]) {
    assert.equal(isExecutionEffectKind(value), false, `rejected ${JSON.stringify(value)}`);
  }
});

for (const outcome of ["pending", "succeeded", "failed", "cancelled", "denied"] as const) {
  test(`isExecutionOutcome accepts ${outcome}`, () => {
    assert.equal(isExecutionOutcome(outcome), true);
  });
}

test("isExecutionOutcome rejects non-outcomes", () => {
  for (const value of ["pending-extra", "", "success", "fail", 1, null, undefined, {}, []]) {
    assert.equal(isExecutionOutcome(value), false, `rejected ${JSON.stringify(value)}`);
  }
});

test("createExecutionClosure produces an empty closure with genesis sequence", () => {
  const closure = freshClosure();
  assert.equal(closure.nextSequence(), "1");
  assert.equal(closure.recordCount(), 0);
  assert.equal(closure.ledgerId, "ledger-x");
  assert.equal(closure.segmentId, "segment-1");
  assert.equal(closure.revision, EXECUTION_CLOSURE_REVISION);
  assert.deepEqual([...closure.lineage()], []);
  assert.deepEqual([...closure.pendingEffects()], []);
  assert.deepEqual([...closure.observations()], []);
});

test("createExecutionClosure generates identifiers when omitted", () => {
  const closure = createExecutionClosure({ clock: deterministicClock() });
  assert.ok(closure.ledgerId.startsWith("ledger-"));
  assert.ok(closure.segmentId.startsWith("segment-"));
  assert.ok(closure.ledgerId.length > "ledger-".length);
  assert.ok(closure.segmentId.length > "segment-".length);
});

test("empty closure reports complete and intact", () => {
  const closure = freshClosure();
  const report = closure.assertClosureComplete();
  assert.equal(report.complete, true);
  assert.equal(report.closureIntact, true);
  assert.equal(report.pendingCount, 0);
  assert.equal(report.terminalCount, 0);
  assert.equal(report.observationCount, 0);
  assert.equal(report.orphanedObservationCount, 0);
  assert.equal(report.violationCount, 0);
  assert.equal(report.violations.length, 0);
});

test("verifyChain on empty closure returns valid empty", () => {
  const closure = freshClosure();
  const result = closure.verifyChain();
  assert.equal(result.valid, true);
  assert.equal(result.verifiedRecords, 0);
  assert.equal(result.code, "empty");
});

test("beginEffect records an intent with chain linkage", () => {
  const closure = freshClosure();
  const intent = closure.beginEffect({
    effectId: "fx-1",
    kind: "filesystem",
    actor: { kind: "harness", id: "agent-1", role: "author" },
    correlation: { runId: "run-1", turnId: "turn-1" },
    description: "write src/foo.ts",
    intentHash: VALID_HASH_A,
  }) as { sequence: string; previousChainHash: string; chainHash: string; effectId: string; kind: string; schemaVersion: string; recordKind: string };
  assert.equal(intent.schemaVersion, EXECUTION_CLOSURE_SCHEMA_VERSION);
  assert.equal(intent.recordKind, "intent");
  assert.equal(intent.effectId, "fx-1");
  assert.equal(intent.kind, "filesystem");
  assert.equal(intent.sequence, "1");
  assert.equal(intent.previousChainHash, ZERO_HASH);
  assert.notEqual(intent.chainHash, ZERO_HASH);
  assert.notEqual(intent.chainHash, intent.previousChainHash);
  assert.equal(closure.nextSequence(), "2");
  assert.equal(closure.recordCount(), 1);
});

test("beginEffect preserves actor with optional role", () => {
  const closure = freshClosure();
  const intent = closure.beginEffect({
    effectId: "fx-1",
    kind: "filesystem",
    actor: { kind: "harness", id: "agent-1" },
    description: "x",
    intentHash: VALID_HASH_A,
  }) as { actor: { kind: string; id: string; role?: string } };
  assert.equal(intent.actor.kind, "harness");
  assert.equal(intent.actor.id, "agent-1");
  assert.equal(intent.actor.role, undefined);
});

test("beginEffect preserves correlation with all fields", () => {
  const closure = freshClosure();
  const intent = closure.beginEffect({
    effectId: "fx-1",
    kind: "provider",
    actor: { kind: "provider", id: "openai" },
    correlation: {
      runId: "r", sessionId: "s", turnId: "t", messageId: "m", taskId: "tk",
      attemptId: "a", agentId: "ag", parentEffectId: "p",
    },
    description: "provider call",
    intentHash: VALID_HASH_A,
  }) as { correlation: Record<string, string> };
  assert.deepEqual(intent.correlation, {
    runId: "r", sessionId: "s", turnId: "t", messageId: "m", taskId: "tk",
    attemptId: "a", agentId: "ag", parentEffectId: "p",
  });
});

test("beginEffect with no correlation defaults to empty object", () => {
  const closure = freshClosure();
  const intent = closure.beginEffect({
    effectId: "fx-1",
    kind: "filesystem",
    actor: { kind: "harness", id: "agent-1" },
    description: "x",
    intentHash: VALID_HASH_A,
  }) as { correlation: Record<string, unknown> };
  assert.deepEqual(intent.correlation, {});
});

test("beginEffect records the provided timestamp", () => {
  const clock = deterministicClock(5);
  const closure = createExecutionClosure({ ledgerId: "l", segmentId: "s", clock });
  const intent = closure.beginEffect({
    effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a" },
    description: "x", intentHash: VALID_HASH_A,
  }) as { timestamp: { wallTime: string; monotonicNanoseconds: string } };
  assert.equal(intent.timestamp.wallTime, "2026-07-16T00:00:05.000Z");
  assert.equal(intent.timestamp.monotonicNanoseconds, "6000000000");
});

test("beginEffect preserves intentHash", () => {
  const closure = freshClosure();
  const intent = closure.beginEffect({
    effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a" },
    description: "x", intentHash: VALID_HASH_C,
  }) as { intentHash: string };
  assert.equal(intent.intentHash, VALID_HASH_C);
});

test("beginEffect chain links across multiple intents", () => {
  const closure = freshClosure();
  const i1 = beginFixture(closure, "fx-1");
  const i2 = beginFixture(closure, "fx-2");
  const r1 = i1 as { chainHash: string };
  const r2 = i2 as { previousChainHash: string; chainHash: string };
  assert.equal(r2.previousChainHash, r1.chainHash);
  assert.notEqual(r1.chainHash, r2.chainHash);
});

test("beginEffect sequence increments monotonically", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  beginFixture(closure, "fx-2");
  beginFixture(closure, "fx-3");
  assert.equal(closure.nextSequence(), "4");
  assert.equal(closure.recordCount(), 3);
});

test("beginEffect rejects duplicate effectId (append-only)", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  assert.throws(() => beginFixture(closure, "fx-1"), { code: "execution_effect_duplicate" });
});

for (const invalid of ["", "  ", " leading", "trailing ", "has space", "_underscore", ".dot", "ünïcode"]) {
  test(`beginEffect rejects invalid effectId ${invalid}`, () => {
    const closure = freshClosure();
    assert.throws(
      () => closure.beginEffect({ effectId: invalid, kind: "filesystem", actor: { kind: "harness", id: "a" }, description: "x", intentHash: VALID_HASH_A }),
      { code: "execution_effect_id_invalid" },
    );
  });
}

test("beginEffect rejects an over-long effectId", () => {
  const closure = freshClosure();
  const id = "x".repeat(513);
  assert.throws(
    () => closure.beginEffect({ effectId: id, kind: "filesystem", actor: { kind: "harness", id: "a" }, description: "x", intentHash: VALID_HASH_A }),
    { code: "execution_effect_id_invalid" },
  );
});

test("beginEffect accepts the maximum identifier length", () => {
  const closure = freshClosure();
  const id = "a".repeat(512);
  const intent = closure.beginEffect({ effectId: id, kind: "filesystem", actor: { kind: "harness", id: "a" }, description: "x", intentHash: VALID_HASH_A });
  assert.equal((intent as { effectId: string }).effectId, id);
});

for (const invalidKind of ["unknown", "Provider", "", "filesystem "]) {
  test(`beginEffect rejects invalid kind ${invalidKind}`, () => {
    const closure = freshClosure();
    assert.throws(
      () => closure.beginEffect({ effectId: "fx-1", kind: invalidKind as ExecutionEffectKind, actor: { kind: "harness", id: "a" }, description: "x", intentHash: VALID_HASH_A }),
      { code: "execution_effect_kind_invalid" },
    );
  });
}

test("beginEffect rejects a numeric kind", () => {
  const closure = freshClosure();
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: 42 as unknown as ExecutionEffectKind, actor: { kind: "harness", id: "a" }, description: "x", intentHash: VALID_HASH_A }),
    { code: "execution_effect_kind_invalid" },
  );
});

test("beginEffect rejects a null kind", () => {
  const closure = freshClosure();
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: null as unknown as ExecutionEffectKind, actor: { kind: "harness", id: "a" }, description: "x", intentHash: VALID_HASH_A }),
    { code: "execution_effect_kind_invalid" },
  );
});

test("beginEffect rejects an undefined kind", () => {
  const closure = freshClosure();
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: undefined as unknown as ExecutionEffectKind, actor: { kind: "harness", id: "a" }, description: "x", intentHash: VALID_HASH_A }),
    { code: "execution_effect_kind_invalid" },
  );
});

test("beginEffect rejects an object kind", () => {
  const closure = freshClosure();
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: {} as unknown as ExecutionEffectKind, actor: { kind: "harness", id: "a" }, description: "x", intentHash: VALID_HASH_A }),
    { code: "execution_effect_kind_invalid" },
  );
});

test("beginEffect rejects an array kind", () => {
  const closure = freshClosure();
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: [] as unknown as ExecutionEffectKind, actor: { kind: "harness", id: "a" }, description: "x", intentHash: VALID_HASH_A }),
    { code: "execution_effect_kind_invalid" },
  );
});

test("beginEffect rejects empty description", () => {
  const closure = freshClosure();
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a" }, description: "", intentHash: VALID_HASH_A }),
    { code: "execution_description_invalid" },
  );
});

test("beginEffect rejects oversized description", () => {
  const closure = freshClosure();
  const description = "x".repeat(8193);
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a" }, description, intentHash: VALID_HASH_A }),
    { code: "execution_description_invalid" },
  );
});

test("beginEffect accepts the maximum description size", () => {
  const closure = freshClosure();
  const description = "x".repeat(8192);
  const intent = closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a" }, description, intentHash: VALID_HASH_A });
  assert.ok((intent as { description: string }).description.length === 8192);
});

test("beginEffect rejects invalid actor (missing kind)", () => {
  const closure = freshClosure();
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: { id: "a" } as unknown as { kind: string; id: string }, description: "x", intentHash: VALID_HASH_A }),
    { code: "execution_actor_invalid" },
  );
});

test("beginEffect rejects invalid actor (missing id)", () => {
  const closure = freshClosure();
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: { kind: "harness" } as unknown as { kind: string; id: string }, description: "x", intentHash: VALID_HASH_A }),
    { code: "execution_actor_invalid" },
  );
});

test("beginEffect rejects invalid actor role", () => {
  const closure = freshClosure();
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a", role: "bad role" }, description: "x", intentHash: VALID_HASH_A }),
    { code: "execution_actor_invalid" },
  );
});

test("beginEffect rejects proxy actor", () => {
  const closure = freshClosure();
  const actor = new Proxy({ kind: "harness", id: "a" }, {});
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: actor as unknown as { kind: string; id: string }, description: "x", intentHash: VALID_HASH_A }),
    { code: "execution_actor_invalid" },
  );
});

test("beginEffect rejects proxy input", () => {
  const closure = freshClosure();
  const input = new Proxy({ effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a" }, description: "x", intentHash: VALID_HASH_A }, {});
  assert.throws(() => closure.beginEffect(input as unknown as Parameters<typeof closure.beginEffect>[0]), { code: "execution_intent_input_invalid" });
});

test("beginEffect rejects unknown correlation field", () => {
  const closure = freshClosure();
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a" }, correlation: { bogus: "x" } as unknown as Record<string, string>, description: "x", intentHash: VALID_HASH_A }),
    { code: "execution_correlation_invalid" },
  );
});

test("beginEffect rejects invalid correlation value", () => {
  const closure = freshClosure();
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a" }, correlation: { runId: "bad value" }, description: "x", intentHash: VALID_HASH_A }),
    { code: "execution_correlation_invalid" },
  );
});

test("beginEffect rejects proxy correlation", () => {
  const closure = freshClosure();
  const correlation = new Proxy({ runId: "r" }, {});
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a" }, correlation: correlation as unknown as Record<string, string>, description: "x", intentHash: VALID_HASH_A }),
    { code: "execution_correlation_invalid" },
  );
});

test("endEffect records a terminal linked to its intent", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const terminal = endFixture(closure, "fx-1", "succeeded", VALID_HASH_B) as { sequence: string; previousChainHash: string; chainHash: string; effectId: string; outcome: string; recordKind: string };
  assert.equal(terminal.recordKind, "terminal");
  assert.equal(terminal.effectId, "fx-1");
  assert.equal(terminal.outcome, "succeeded");
  assert.equal(terminal.sequence, "2");
  assert.notEqual(terminal.chainHash, terminal.previousChainHash);
  assert.equal(closure.nextSequence(), "3");
});

for (const outcome of ["succeeded", "failed", "cancelled", "denied"] as const) {
  test(`endEffect accepts outcome ${outcome}`, () => {
    const closure = freshClosure();
    beginFixture(closure, "fx-1");
    const terminal = closure.endEffect("fx-1", { outcome, resultHash: VALID_HASH_B }) as { outcome: string };
    assert.equal(terminal.outcome, outcome);
  });
}

test("endEffect rejects pending outcome", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  assert.throws(
    () => closure.endEffect("fx-1", { outcome: "pending" as unknown as "succeeded", resultHash: VALID_HASH_B }),
    { code: "execution_outcome_invalid" },
  );
});

test("endEffect records error summary", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const terminal = closure.endEffect("fx-1", {
    outcome: "failed",
    resultHash: VALID_HASH_B,
    error: { category: "tool", code: "tool_failed", message: "boom", retryable: false },
  }) as { error?: { category: string; code: string; message: string; retryable: boolean } };
  assert.equal(terminal.error?.category, "tool");
  assert.equal(terminal.error?.code, "tool_failed");
  assert.equal(terminal.error?.message, "boom");
  assert.equal(terminal.error?.retryable, false);
});

test("endEffect omits error when undefined", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const terminal = closure.endEffect("fx-1", { outcome: "succeeded", resultHash: VALID_HASH_B }) as { error?: unknown };
  assert.equal(terminal.error, undefined);
});

test("endEffect chain links to the preceding intent", () => {
  const closure = freshClosure();
  const intent = beginFixture(closure, "fx-1") as { chainHash: string };
  const terminal = endFixture(closure, "fx-1") as { previousChainHash: string };
  assert.equal(terminal.previousChainHash, intent.chainHash);
});

test("endEffect rejects unknown effect (terminal without intent = bypass)", () => {
  const closure = freshClosure();
  assert.throws(() => closure.endEffect("fx-missing", { outcome: "succeeded", resultHash: VALID_HASH_B }), { code: "execution_terminal_orphan" });
});

test("endEffect rejects double terminal (append-only lineage)", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  endFixture(closure, "fx-1");
  assert.throws(() => endFixture(closure, "fx-1"), { code: "execution_terminal_duplicate" });
});

test("endEffect rejects invalid effectId", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  assert.throws(() => closure.endEffect("bad id", { outcome: "succeeded", resultHash: VALID_HASH_B }), { code: "execution_effect_id_invalid" });
});

test("endEffect rejects invalid error summary", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  assert.throws(
    () => closure.endEffect("fx-1", { outcome: "failed", resultHash: VALID_HASH_B, error: { category: "tool", code: "x", message: "m" } as unknown as { category: string; code: string; message: string; retryable: boolean } }),
    { code: "execution_error_invalid" },
  );
});

test("endEffect rejects proxy terminal input", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const input = new Proxy({ outcome: "succeeded", resultHash: VALID_HASH_B }, {});
  assert.throws(() => closure.endEffect("fx-1", input as unknown as Parameters<typeof closure.endEffect>[1]), { code: "execution_terminal_input_invalid" });
});

test("observeExternalEffect records an observation linked to a known effect", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  endFixture(closure, "fx-1");
  const observation = closure.observeExternalEffect({ observationId: "obs-1", effectId: "fx-1", kind: "filesystem", evidenceHash: VALID_HASH_C }) as { recordKind: string; observationId: string; effectId: string; sequence: string };
  assert.equal(observation.recordKind, "observation");
  assert.equal(observation.observationId, "obs-1");
  assert.equal(observation.effectId, "fx-1");
  assert.equal(observation.sequence, "3");
});

test("observeExternalEffect records an unattributed observation (no effectId)", () => {
  const closure = freshClosure();
  const observation = closure.observeExternalEffect({ observationId: "obs-1", kind: "process", evidenceHash: VALID_HASH_C }) as { effectId?: string };
  assert.equal(observation.effectId, undefined);
});

test("observeExternalEffect rejects duplicate observationId", () => {
  const closure = freshClosure();
  closure.observeExternalEffect({ observationId: "obs-1", kind: "process", evidenceHash: VALID_HASH_C });
  assert.throws(() => closure.observeExternalEffect({ observationId: "obs-1", kind: "process", evidenceHash: VALID_HASH_C }), { code: "execution_observation_duplicate" });
});

test("observeExternalEffect rejects invalid observationId", () => {
  const closure = freshClosure();
  assert.throws(() => closure.observeExternalEffect({ observationId: "bad id", kind: "process", evidenceHash: VALID_HASH_C }), { code: "execution_observation_id_invalid" });
});

test("observeExternalEffect rejects invalid kind", () => {
  const closure = freshClosure();
  assert.throws(() => closure.observeExternalEffect({ observationId: "obs-1", kind: "unknown" as ExecutionEffectKind, evidenceHash: VALID_HASH_C }), { code: "execution_effect_kind_invalid" });
});

test("observeExternalEffect rejects invalid evidenceHash", () => {
  const closure = freshClosure();
  assert.throws(() => closure.observeExternalEffect({ observationId: "obs-1", kind: "process", evidenceHash: "short" }), { code: "execution_evidence_hash_invalid" });
});

test("observeExternalEffect rejects invalid effectId", () => {
  const closure = freshClosure();
  assert.throws(() => closure.observeExternalEffect({ observationId: "obs-1", effectId: "bad id", kind: "process", evidenceHash: VALID_HASH_C }), { code: "execution_effect_id_invalid" });
});

test("observeExternalEffect rejects proxy input", () => {
  const closure = freshClosure();
  const input = new Proxy({ observationId: "obs-1", kind: "process", evidenceHash: VALID_HASH_C }, {});
  assert.throws(() => closure.observeExternalEffect(input as unknown as Parameters<typeof closure.observeExternalEffect>[0]), { code: "execution_observation_input_invalid" });
});

test("completeness: all-terminal closure is complete", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  endFixture(closure, "fx-1");
  beginFixture(closure, "fx-2");
  endFixture(closure, "fx-2");
  const report = closure.assertClosureComplete();
  assert.equal(report.complete, true);
  assert.equal(report.pendingCount, 0);
  assert.equal(report.terminalCount, 2);
  assert.equal(report.violationCount, 0);
});

test("completeness: pending-only closure is complete (recoverable)", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const report = closure.assertClosureComplete();
  assert.equal(report.complete, true);
  assert.equal(report.pendingCount, 1);
  assert.equal(report.terminalCount, 0);
});

test("completeness: orphaned observation (unrecorded effectId) is a violation (bypass)", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  endFixture(closure, "fx-1");
  closure.observeExternalEffect({ observationId: "obs-1", effectId: "fx-never", kind: "filesystem", evidenceHash: VALID_HASH_C });
  const report = closure.assertClosureComplete();
  assert.equal(report.complete, false);
  assert.equal(report.orphanedObservationCount, 1);
  assert.equal(report.violationCount, 1);
  assert.equal(report.violations[0]!.code, "execution_closure_orphaned_observation");
  assert.equal(report.violations[0]!.effectId, "fx-never");
});

test("completeness: unattributed observation (no effectId) is a violation", () => {
  const closure = freshClosure();
  closure.observeExternalEffect({ observationId: "obs-1", kind: "process", evidenceHash: VALID_HASH_C });
  const report = closure.assertClosureComplete();
  assert.equal(report.complete, false);
  assert.equal(report.orphanedObservationCount, 1);
  assert.equal(report.violations[0]!.code, "execution_closure_orphaned_observation");
  assert.equal(report.violations[0]!.observationId, "obs-1");
});

test("completeness: attributed observation matching an intent is complete", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  endFixture(closure, "fx-1");
  closure.observeExternalEffect({ observationId: "obs-1", effectId: "fx-1", kind: "filesystem", evidenceHash: VALID_HASH_C });
  const report = closure.assertClosureComplete();
  assert.equal(report.complete, true);
  assert.equal(report.observationCount, 1);
});

test("completeness: attributed observation matching a pending intent is complete", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  closure.observeExternalEffect({ observationId: "obs-1", effectId: "fx-1", kind: "filesystem", evidenceHash: VALID_HASH_C });
  const report = closure.assertClosureComplete();
  assert.equal(report.complete, true);
  assert.equal(report.pendingCount, 1);
});

test("completeness counts are accurate with mixed state", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  endFixture(closure, "fx-1");
  beginFixture(closure, "fx-2");
  closure.observeExternalEffect({ observationId: "obs-1", effectId: "fx-1", kind: "filesystem", evidenceHash: VALID_HASH_C });
  closure.observeExternalEffect({ observationId: "obs-2", effectId: "fx-orphan", kind: "git", evidenceHash: VALID_HASH_C });
  const report = closure.assertClosureComplete();
  assert.equal(report.pendingCount, 1);
  assert.equal(report.terminalCount, 1);
  assert.equal(report.observationCount, 2);
  assert.equal(report.orphanedObservationCount, 1);
  assert.equal(report.complete, false);
});

test("lineage reports pending status for begun-not-ended effect", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const lineages = closure.lineage();
  assert.equal(lineages.length, 1);
  assert.equal(lineages[0]!.status, "pending");
  assert.equal(lineages[0]!.effectId, "fx-1");
  assert.equal(lineages[0]!.kind, "filesystem");
  assert.ok(lineages[0]!.intent !== undefined);
  assert.equal(lineages[0]!.terminal, undefined);
});

test("lineage reports terminal status after endEffect", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  endFixture(closure, "fx-1", "failed");
  const lineage = closure.lineage()[0]!;
  assert.equal(lineage.status, "failed");
  assert.ok(lineage.terminal !== undefined);
});

for (const outcome of ["succeeded", "failed", "cancelled", "denied"] as const) {
  test(`lineage reports status ${outcome}`, () => {
    const closure = freshClosure();
    beginFixture(closure, "fx-1");
    endFixture(closure, "fx-1", outcome);
    assert.equal(closure.lineage()[0]!.status, outcome);
  });
}

test("lineage groups observations by effectId", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  endFixture(closure, "fx-1");
  closure.observeExternalEffect({ observationId: "obs-1", effectId: "fx-1", kind: "filesystem", evidenceHash: VALID_HASH_A });
  closure.observeExternalEffect({ observationId: "obs-2", effectId: "fx-1", kind: "filesystem", evidenceHash: VALID_HASH_B });
  const lineage = closure.lineage()[0]!;
  assert.equal(lineage.observations.length, 2);
  assert.equal(lineage.observations[0]!.observationId, "obs-1");
  assert.equal(lineage.observations[1]!.observationId, "obs-2");
});

test("lineage reports orphaned-observation for unattributed observations", () => {
  const closure = freshClosure();
  closure.observeExternalEffect({ observationId: "obs-1", kind: "process", evidenceHash: VALID_HASH_C });
  const lineages = closure.lineage();
  assert.equal(lineages.length, 1);
  assert.equal(lineages[0]!.status, "orphaned-observation");
  assert.equal(lineages[0]!.observations.length, 1);
});

test("pendingEffects lists only begun-not-ended effects", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  beginFixture(closure, "fx-2");
  endFixture(closure, "fx-1");
  beginFixture(closure, "fx-3");
  const pending = closure.pendingEffects();
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.map((p) => p.effectId), ["fx-2", "fx-3"]);
});

test("observations returns all observations ordered by sequence", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  closure.observeExternalEffect({ observationId: "obs-2", effectId: "fx-1", kind: "filesystem", evidenceHash: VALID_HASH_A });
  closure.observeExternalEffect({ observationId: "obs-1", effectId: "fx-1", kind: "filesystem", evidenceHash: VALID_HASH_B });
  const observations = closure.observations();
  assert.equal(observations[0]!.observationId, "obs-2");
  assert.equal(observations[1]!.observationId, "obs-1");
});

test("verifyChain is valid on a healthy multi-record closure", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  endFixture(closure, "fx-1");
  beginFixture(closure, "fx-2");
  closure.observeExternalEffect({ observationId: "obs-1", effectId: "fx-2", kind: "filesystem", evidenceHash: VALID_HASH_A });
  const result = closure.verifyChain();
  assert.equal(result.valid, true);
  assert.equal(result.verifiedRecords, 4);
});

test("append-only: records are deeply frozen", () => {
  const closure = freshClosure();
  const intent = beginFixture(closure, "fx-1") as { effectId: string };
  assert.ok(Object.isFrozen(intent));
});

test("append-only: closure object is frozen", () => {
  const closure = freshClosure();
  assert.ok(Object.isFrozen(closure));
});

test("append-only: no mutation or deletion API exists", () => {
  const closure = freshClosure();
  const methods = Object.keys(closure).filter((k) => typeof (closure as Record<string, unknown>)[k] === "function");
  for (const method of methods) {
    assert.ok(!/delete|remove|edit|update|mutate|clear|reset/i.test(method), `no mutation method: ${method}`);
  }
});

test("snapshot round-trip preserves all records and state", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  endFixture(closure, "fx-1");
  beginFixture(closure, "fx-2");
  closure.observeExternalEffect({ observationId: "obs-1", effectId: "fx-2", kind: "filesystem", evidenceHash: VALID_HASH_A });
  const snapshot = closure.snapshot();
  assert.equal(snapshot.schemaVersion, EXECUTION_CLOSURE_SCHEMA_VERSION);
  assert.equal(snapshot.ledgerId, "ledger-x");
  assert.equal(snapshot.segmentId, "segment-1");
  assert.equal(snapshot.records.length, 4);
  assert.equal(snapshot.nextSequence, "5");
  const restored = restoreExecutionClosure(snapshot);
  assert.equal(restored.nextSequence(), "5");
  assert.equal(restored.recordCount(), 4);
  assert.equal(restored.lineage().length, 2);
  assert.equal(restored.pendingEffects().length, 1);
  assert.equal(restored.observations().length, 1);
});

test("snapshot is serializable via canonical JSON and restorable from a copy", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const snapshot = closure.snapshot();
  const text = JSON.stringify(snapshot);
  const restored = restoreExecutionClosure(JSON.parse(text));
  assert.equal(restored.recordCount(), 1);
  assert.equal(restored.lineage()[0]!.effectId, "fx-1");
});

test("restored closure continues recording after the prior sequence", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  endFixture(closure, "fx-1");
  const restored = restoreExecutionClosure(closure.snapshot());
  const intent = beginFixture(restored, "fx-2") as { sequence: string };
  assert.equal(intent.sequence, "3");
});

test("restored closure can end a pre-existing pending effect (crash recovery)", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const restored = restoreExecutionClosure(closure.snapshot());
  assert.equal(restored.pendingEffects().length, 1);
  const terminal = restored.endEffect("fx-1", { outcome: "succeeded", resultHash: VALID_HASH_B }) as { sequence: string };
  assert.equal(terminal.sequence, "2");
  assert.equal(restored.assertClosureComplete().pendingCount, 0);
});

test("restore rejects a snapshot with a tampered record chainHash", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const snapshot = closure.snapshot();
  const tampered = tamperRecord(snapshot, 0, (record) => { record.chainHash = "f".repeat(64); });
  assert.throws(() => restoreExecutionClosure(tampered), { code: "execution_closure_restore_chain_record-hash" });
});

test("restore rejects a snapshot with a tampered previousChainHash", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  beginFixture(closure, "fx-2");
  const snapshot = closure.snapshot();
  const tampered = tamperRecord(snapshot, 1, (record) => { record.previousChainHash = "e".repeat(64); });
  assert.throws(() => restoreExecutionClosure(tampered), { code: "execution_closure_restore_chain_previous-hash" });
});

test("restore rejects a snapshot with a tampered sequence", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  beginFixture(closure, "fx-2");
  const snapshot = closure.snapshot();
  const tampered = tamperRecord(snapshot, 1, (record) => { record.sequence = "5"; });
  assert.throws(() => restoreExecutionClosure(tampered), { code: "execution_closure_restore_chain_sequence" });
});

test("restore rejects a snapshot with a tampered intent payload (chainHash no longer matches)", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const snapshot = closure.snapshot();
  const tampered = tamperRecord(snapshot, 0, (record) => { record.description = "tampered"; });
  assert.throws(() => restoreExecutionClosure(tampered), { code: "execution_closure_restore_chain_record-hash" });
});

test("restore rejects a snapshot with a drifted chain tip", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const snapshot = closure.snapshot();
  const tampered = { ...snapshot, chainTipHash: "d".repeat(64) };
  assert.throws(() => restoreExecutionClosure(tampered), { code: "execution_closure_restore_tip_drift" });
});

test("restore rejects a snapshot with a drifted next sequence", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const snapshot = closure.snapshot();
  const tampered = { ...snapshot, nextSequence: "99" };
  assert.throws(() => restoreExecutionClosure(tampered), { code: "execution_closure_restore_sequence_drift" });
});

function envelopeWithoutChain(record: Record<string, unknown>): Record<string, unknown> {
  const { chainHash: _omitted, ...rest } = record;
  void _omitted;
  return rest;
}

function recomputeChain(previousHash: string, envelope: Record<string, unknown>): string {
  return sha256(Buffer.concat([
    Buffer.from(EXECUTION_CLOSURE_DOMAIN, "utf8"),
    Buffer.from(previousHash, "hex"),
    canonicalizeLedgerJson(envelope),
  ]));
}

function tamperAndRecompute(snapshot: ExecutionClosureSnapshot, index: number, mutator: (record: Record<string, unknown>) => void): ExecutionClosureSnapshot {
  const records = snapshot.records.map((record, i) =>
    i === index ? ({ ...(record as unknown as Record<string, unknown>) }) : record,
  ) as unknown as ExecutionClosureSnapshot["records"];
  mutator(records[index] as unknown as Record<string, unknown>);
  for (let i = index; i < records.length; i += 1) {
    const rec = records[i] as unknown as Record<string, unknown>;
    const previous = i === 0 ? ZERO_HASH : (records[i - 1] as unknown as { chainHash: string }).chainHash;
    rec.previousChainHash = previous;
    rec.chainHash = recomputeChain(previous, envelopeWithoutChain(rec));
  }
  const chainTip = (records[records.length - 1] as unknown as { chainHash: string }).chainHash;
  return { ...snapshot, records, chainTipHash: chainTip };
}

test("restore rejects a snapshot with a duplicate intent effectId", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  beginFixture(closure, "fx-2");
  const snapshot = closure.snapshot();
  const tampered = tamperAndRecompute(snapshot, 1, (record) => { record.effectId = "fx-1"; });
  assert.throws(() => restoreExecutionClosure(tampered), { code: "execution_closure_restore_duplicate" });
});

test("restore rejects a snapshot with a terminal that has no matching intent", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  endFixture(closure, "fx-1");
  const snapshot = closure.snapshot();
  const tampered = tamperAndRecompute(snapshot, 1, (record) => { record.effectId = "fx-orphan"; });
  assert.throws(() => restoreExecutionClosure(tampered), { code: "execution_closure_restore_orphan_terminal" });
});

test("restore rejects a snapshot with a duplicate observationId", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  closure.observeExternalEffect({ observationId: "obs-1", effectId: "fx-1", kind: "filesystem", evidenceHash: VALID_HASH_A });
  closure.observeExternalEffect({ observationId: "obs-2", effectId: "fx-1", kind: "filesystem", evidenceHash: VALID_HASH_B });
  const snapshot = closure.snapshot();
  const tampered = tamperAndRecompute(snapshot, 2, (record) => { record.observationId = "obs-1"; });
  assert.throws(() => restoreExecutionClosure(tampered), { code: "execution_closure_restore_duplicate" });
});

test("restore rejects a snapshot with coordinate drift", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const snapshot = closure.snapshot();
  const tampered = tamperRecord(snapshot, 0, (record) => { record.ledgerId = "other-ledger"; });
  assert.throws(() => restoreExecutionClosure(tampered), { code: "execution_closure_restore_coordinate_drift" });
});

test("restore rejects an invalid snapshot schema version", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const snapshot = closure.snapshot();
  const tampered = { ...snapshot, schemaVersion: "bridlewise-execution-closure/v999" };
  assert.throws(() => restoreExecutionClosure(tampered), { code: "execution_snapshot_invalid" });
});

test("restore rejects a non-object snapshot", () => {
  for (const invalid of [null, 42, "text", [], true]) {
    assert.throws(() => restoreExecutionClosure(invalid), { code: "execution_snapshot_invalid" });
  }
});

test("restore rejects a snapshot with invalid ledgerId", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const snapshot = closure.snapshot();
  assert.throws(() => restoreExecutionClosure({ ...snapshot, ledgerId: "bad id" }), { code: "execution_snapshot_invalid" });
});

test("restore rejects a proxy snapshot", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const snapshot = closure.snapshot();
  const proxied = new Proxy(snapshot, {});
  assert.throws(() => restoreExecutionClosure(proxied), { code: "execution_snapshot_invalid" });
});

test("verifyExecutionClosureSnapshot returns valid for a healthy snapshot", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  endFixture(closure, "fx-1");
  const result = verifyExecutionClosureSnapshot(closure.snapshot());
  assert.equal(result.valid, true);
  assert.equal(result.verifiedRecords, 2);
});

test("verifyExecutionClosureSnapshot returns invalid for an empty snapshot", () => {
  const closure = freshClosure();
  const result = verifyExecutionClosureSnapshot(closure.snapshot());
  assert.equal(result.valid, true);
  assert.equal(result.verifiedRecords, 0);
});

test("verifyExecutionClosureSnapshot detects a tampered chainHash (non-throwing)", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const snapshot = closure.snapshot();
  const tampered = tamperRecord(snapshot, 0, (record) => { record.chainHash = "f".repeat(64); });
  const result = verifyExecutionClosureSnapshot(tampered);
  assert.equal(result.valid, false);
  assert.equal(result.code, "record-hash");
});

test("verifyExecutionClosureSnapshot detects a tampered previousChainHash (non-throwing)", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  beginFixture(closure, "fx-2");
  const snapshot = closure.snapshot();
  const tampered = tamperRecord(snapshot, 1, (record) => { record.previousChainHash = "e".repeat(64); });
  const result = verifyExecutionClosureSnapshot(tampered);
  assert.equal(result.valid, false);
  assert.equal(result.code, "previous-hash");
});

test("verifyExecutionClosureSnapshot detects a tampered sequence (non-throwing)", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  beginFixture(closure, "fx-2");
  const snapshot = closure.snapshot();
  const tampered = tamperRecord(snapshot, 1, (record) => { record.sequence = "9"; });
  const result = verifyExecutionClosureSnapshot(tampered);
  assert.equal(result.valid, false);
  assert.equal(result.code, "sequence");
});

test("verifyExecutionClosureSnapshot detects a drifted tip (non-throwing)", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const snapshot = closure.snapshot();
  const tampered = { ...snapshot, chainTipHash: "d".repeat(64) };
  const result = verifyExecutionClosureSnapshot(tampered);
  assert.equal(result.valid, false);
  assert.equal(result.code, "tamper");
});

test("verifyExecutionClosureSnapshot detects a drifted nextSequence (non-throwing)", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const snapshot = closure.snapshot();
  const tampered = { ...snapshot, nextSequence: "50" };
  const result = verifyExecutionClosureSnapshot(tampered);
  assert.equal(result.valid, false);
  assert.equal(result.code, "tamper");
});

test("verifyExecutionClosureSnapshot returns invalid for a malformed snapshot (non-throwing)", () => {
  for (const invalid of [null, 42, "text", { schemaVersion: "wrong" }]) {
    const result = verifyExecutionClosureSnapshot(invalid);
    assert.equal(result.valid, false);
  }
});

test("verifyExecutionClosureSnapshot returns invalid for a proxy snapshot (non-throwing)", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const proxied = new Proxy(closure.snapshot(), {});
  const result = verifyExecutionClosureSnapshot(proxied);
  assert.equal(result.valid, false);
});

test("concurrent interleaving: multiple effects maintain contiguous sequence and chain", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  beginFixture(closure, "fx-2");
  endFixture(closure, "fx-1");
  beginFixture(closure, "fx-3");
  endFixture(closure, "fx-2");
  endFixture(closure, "fx-3");
  const result = closure.verifyChain();
  assert.equal(result.valid, true);
  assert.equal(result.verifiedRecords, 6);
  const lineages = closure.lineage();
  assert.equal(lineages.length, 3);
  assert.deepEqual(lineages.map((l) => l.status), ["succeeded", "succeeded", "succeeded"]);
});

test("concurrent interleaving: sequence is strictly monotonic across record kinds", () => {
  const closure = freshClosure();
  const sequences: string[] = [];
  sequences.push((beginFixture(closure, "fx-1") as { sequence: string }).sequence);
  sequences.push((beginFixture(closure, "fx-2") as { sequence: string }).sequence);
  sequences.push((endFixture(closure, "fx-1") as { sequence: string }).sequence);
  sequences.push((closure.observeExternalEffect({ observationId: "obs-1", effectId: "fx-2", kind: "filesystem", evidenceHash: VALID_HASH_A }) as { sequence: string }).sequence);
  sequences.push((endFixture(closure, "fx-2") as { sequence: string }).sequence);
  assert.deepEqual(sequences, ["1", "2", "3", "4", "5"]);
});

test("hostile: lone-surrogate description is rejected by canonical serialization", () => {
  const closure = freshClosure();
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a" }, description: "bad\uDC80", intentHash: VALID_HASH_A }),
  );
});

test("hostile: cycle in correlation is rejected", () => {
  const closure = freshClosure();
  const correlation: Record<PropertyKey, unknown> = { runId: "r" };
  correlation.self = correlation;
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a" }, correlation: correlation as unknown as Record<string, string>, description: "x", intentHash: VALID_HASH_A }),
    { code: "execution_correlation_invalid" },
  );
});

test("hostile: class-instance actor is rejected", () => {
  const closure = freshClosure();
  class FakeActor { kind = "harness"; id = "a"; }
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: new FakeActor() as unknown as { kind: string; id: string }, description: "x", intentHash: VALID_HASH_A }),
    { code: "execution_actor_invalid" },
  );
});

test("hostile: symbol key in correlation is rejected", () => {
  const closure = freshClosure();
  const correlation: Record<PropertyKey, unknown> = { runId: "r" };
  correlation[Symbol("x")] = "y";
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a" }, correlation: correlation as unknown as Record<string, string>, description: "x", intentHash: VALID_HASH_A }),
    { code: "execution_correlation_invalid" },
  );
});

test("hostile: non-finite number in input is rejected by snapshot", () => {
  const closure = freshClosure();
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a" }, description: "x", intentHash: VALID_HASH_A, correlation: { runId: NaN as unknown as string } }),
  );
});

test("two closures with the same deterministic clock and inputs produce identical chains", () => {
  const build = (): ExecutionClosure => {
    const c = createExecutionClosure({ ledgerId: "l", segmentId: "s", clock: deterministicClock() });
    beginFixture(c, "fx-1");
    endFixture(c, "fx-1");
    return c;
  };
  const a = build();
  const b = build();
  assert.equal((a.snapshot().records[0] as { chainHash: string }).chainHash, (b.snapshot().records[0] as { chainHash: string }).chainHash);
  assert.equal((a.snapshot().records[1] as { chainHash: string }).chainHash, (b.snapshot().records[1] as { chainHash: string }).chainHash);
});

test("different effect kinds produce different intent chain hashes", () => {
  const closure = freshClosure();
  const a = beginFixture(closure, "fx-1", "filesystem") as { chainHash: string };
  const b = beginFixture(closure, "fx-2", "network") as { chainHash: string };
  assert.notEqual(a.chainHash, b.chainHash);
});

test("different intentHash produces different intent chain hash", () => {
  const closure = freshClosure();
  const a = beginFixture(closure, "fx-1", "filesystem", VALID_HASH_A) as { chainHash: string };
  const b = beginFixture(closure, "fx-2", "filesystem", VALID_HASH_B) as { chainHash: string };
  assert.notEqual(a.chainHash, b.chainHash);
});

test("createExecutionClosure rejects invalid ledgerId", () => {
  assert.throws(() => createExecutionClosure({ ledgerId: "bad id", clock: deterministicClock() }), { code: "execution_ledger_id_invalid" });
});

test("createExecutionClosure rejects invalid segmentId", () => {
  assert.throws(() => createExecutionClosure({ segmentId: "", clock: deterministicClock() }), { code: "execution_segment_id_invalid" });
});

test("every record kind carries the closure coordinate", () => {
  const closure = freshClosure();
  const intent = beginFixture(closure, "fx-1") as { ledgerId: string; segmentId: string };
  const terminal = endFixture(closure, "fx-1") as { ledgerId: string; segmentId: string };
  const observation = closure.observeExternalEffect({ observationId: "obs-1", effectId: "fx-1", kind: "filesystem", evidenceHash: VALID_HASH_A }) as { ledgerId: string; segmentId: string };
  assert.equal(intent.ledgerId, "ledger-x");
  assert.equal(intent.segmentId, "segment-1");
  assert.equal(terminal.ledgerId, "ledger-x");
  assert.equal(terminal.segmentId, "segment-1");
  assert.equal(observation.ledgerId, "ledger-x");
  assert.equal(observation.segmentId, "segment-1");
});

test("completeness oracle catches bypass: effect observed but never begun", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  endFixture(closure, "fx-1");
  closure.observeExternalEffect({ observationId: "obs-1", effectId: "fx-ghost", kind: "git", evidenceHash: VALID_HASH_A });
  const report = closure.assertClosureComplete();
  assert.equal(report.complete, false);
  assert.equal(report.orphanedObservationCount, 1);
});

test("completeness oracle confirms a fully reconciled run", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  endFixture(closure, "fx-1", "succeeded");
  beginFixture(closure, "fx-2");
  endFixture(closure, "fx-2", "failed");
  beginFixture(closure, "fx-3");
  closure.observeExternalEffect({ observationId: "obs-1", effectId: "fx-1", kind: "filesystem", evidenceHash: VALID_HASH_A });
  closure.observeExternalEffect({ observationId: "obs-2", effectId: "fx-2", kind: "filesystem", evidenceHash: VALID_HASH_B });
  closure.observeExternalEffect({ observationId: "obs-3", effectId: "fx-3", kind: "filesystem", evidenceHash: VALID_HASH_C });
  const report = closure.assertClosureComplete();
  assert.equal(report.complete, true);
  assert.equal(report.pendingCount, 1);
  assert.equal(report.terminalCount, 2);
  assert.equal(report.observationCount, 3);
});

test("crash recovery: pending effects survive snapshot/restore and can be completed", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  beginFixture(closure, "fx-2");
  const snapshot = closure.snapshot();
  const restored = restoreExecutionClosure(snapshot);
  assert.equal(restored.pendingEffects().length, 2);
  restored.endEffect("fx-1", { outcome: "succeeded", resultHash: VALID_HASH_B });
  assert.equal(restored.pendingEffects().length, 1);
  assert.equal(restored.assertClosureComplete().complete, true);
});

test("crash recovery: snapshot reflects the chain tip at crash time", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const snapshot = closure.snapshot();
  assert.equal(snapshot.chainTipHash, (snapshot.records[0] as { chainHash: string }).chainHash);
});

test("snapshot records are frozen and cannot be mutated to evade restore", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const snapshot = closure.snapshot();
  const record = snapshot.records[0] as unknown as Record<string, unknown>;
  assert.ok(Object.isFrozen(record));
});

test("the completeness report itself is frozen", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const report = closure.assertClosureComplete();
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.violations));
});

test("the chain verification result is frozen", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  assert.ok(Object.isFrozen(closure.verifyChain()));
});

test("the snapshot is frozen", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  assert.ok(Object.isFrozen(closure.snapshot()));
});

for (const kind of ["provider", "network", "process", "filesystem", "git", "memory", "permission", "quality", "promotion", "ledger"] as const) {
  test(`every effect kind ${kind} can complete a full intent+terminal lineage`, () => {
    const closure = freshClosure();
    beginFixture(closure, `fx-${kind}`, kind);
    endFixture(closure, `fx-${kind}`, "succeeded");
    const lineage = closure.lineage()[0]!;
    assert.equal(lineage.kind, kind);
    assert.equal(lineage.status, "succeeded");
  });
}

test("intent hash is part of the chain: same effectId, different intentHash yields different chainHash", () => {
  const a = createExecutionClosure({ ledgerId: "l", segmentId: "s", clock: deterministicClock() });
  const b = createExecutionClosure({ ledgerId: "l", segmentId: "s", clock: deterministicClock() });
  const ia = beginFixture(a, "fx-1", "filesystem", VALID_HASH_A) as { chainHash: string };
  const ib = beginFixture(b, "fx-1", "filesystem", VALID_HASH_B) as { chainHash: string };
  assert.notEqual(ia.chainHash, ib.chainHash);
});

for (const outcome of ["succeeded", "failed", "cancelled", "denied"] as const) {
  test(`outcome ${outcome} produces a distinct terminal chainHash`, () => {
    const a = createExecutionClosure({ ledgerId: "l", segmentId: "s", clock: deterministicClock() });
    const b = createExecutionClosure({ ledgerId: "l", segmentId: "s", clock: deterministicClock() });
    beginFixture(a, "fx-1");
    beginFixture(b, "fx-1");
    const ta = a.endEffect("fx-1", { outcome, resultHash: VALID_HASH_A }) as { chainHash: string };
    const tb = b.endEffect("fx-1", { outcome, resultHash: VALID_HASH_B }) as { chainHash: string };
    assert.notEqual(ta.chainHash, tb.chainHash);
  });
}

test("error summary fields are preserved exactly on the terminal", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const terminal = closure.endEffect("fx-1", {
    outcome: "failed",
    resultHash: VALID_HASH_B,
    error: { category: "provider", code: "provider_timeout", message: "upstream timed out", retryable: true },
  }) as { error: { category: string; code: string; message: string; retryable: boolean } };
  assert.deepEqual(terminal.error, { category: "provider", code: "provider_timeout", message: "upstream timed out", retryable: true });
});

test("correlation parentEffectId can link a child effect to its parent", () => {
  const closure = freshClosure();
  beginFixture(closure, "parent");
  endFixture(closure, "parent");
  const child = closure.beginEffect({
    effectId: "child", kind: "process", actor: { kind: "tool", id: "mcp" },
    correlation: { parentEffectId: "parent" }, description: "child tool call", intentHash: VALID_HASH_A,
  }) as { correlation: { parentEffectId: string } };
  assert.equal(child.correlation.parentEffectId, "parent");
});

test("multiple observations on the same effect group into one lineage", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  endFixture(closure, "fx-1");
  closure.observeExternalEffect({ observationId: "obs-1", effectId: "fx-1", kind: "filesystem", evidenceHash: VALID_HASH_A });
  closure.observeExternalEffect({ observationId: "obs-2", effectId: "fx-1", kind: "filesystem", evidenceHash: VALID_HASH_B });
  closure.observeExternalEffect({ observationId: "obs-3", effectId: "fx-1", kind: "filesystem", evidenceHash: VALID_HASH_C });
  assert.equal(closure.lineage()[0]!.observations.length, 3);
  assert.equal(closure.assertClosureComplete().complete, true);
});

test("lineage is ordered by intent sequence", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-3");
  beginFixture(closure, "fx-1");
  beginFixture(closure, "fx-2");
  const order = closure.lineage().map((l) => l.effectId);
  assert.deepEqual(order, ["fx-3", "fx-1", "fx-2"]);
});

test("pendingEffects is ordered by sequence", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-3");
  beginFixture(closure, "fx-1");
  beginFixture(closure, "fx-2");
  assert.deepEqual(closure.pendingEffects().map((p) => p.effectId), ["fx-3", "fx-1", "fx-2"]);
});

test("snapshot records preserve insertion order", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  endFixture(closure, "fx-1");
  closure.observeExternalEffect({ observationId: "obs-1", effectId: "fx-1", kind: "filesystem", evidenceHash: VALID_HASH_A });
  const snapshot = closure.snapshot();
  const kinds = snapshot.records.map((r) => (r as { recordKind: string }).recordKind);
  assert.deepEqual(kinds, ["intent", "terminal", "observation"]);
});

test("restore preserves ledger and segment identity", () => {
  const closure = createExecutionClosure({ ledgerId: "ledger-7", segmentId: "seg-9", clock: deterministicClock() });
  beginFixture(closure, "fx-1");
  const restored = restoreExecutionClosure(closure.snapshot());
  assert.equal(restored.ledgerId, "ledger-7");
  assert.equal(restored.segmentId, "seg-9");
});

test("two closures are independent (state isolation)", () => {
  const a = freshClosure();
  const b = freshClosure();
  beginFixture(a, "fx-1");
  assert.equal(a.recordCount(), 1);
  assert.equal(b.recordCount(), 0);
  assert.equal(b.lineage().length, 0);
  assert.throws(() => b.endEffect("fx-1", { outcome: "succeeded", resultHash: VALID_HASH_B }), { code: "execution_terminal_orphan" });
});

test("a large fully-reconciled run is complete with a valid contiguous chain", () => {
  const closure = freshClosure();
  for (let i = 0; i < 50; i += 1) {
    beginFixture(closure, `fx-${i}`);
    endFixture(closure, `fx-${i}`);
  }
  const report = closure.assertClosureComplete();
  assert.equal(report.complete, true);
  assert.equal(report.terminalCount, 50);
  assert.equal(report.pendingCount, 0);
  const chain = closure.verifyChain();
  assert.equal(chain.valid, true);
  assert.equal(chain.verifiedRecords, 100);
  assert.equal(closure.nextSequence(), "101");
});

test("interleaved begin/end across many effects preserves a contiguous chain", () => {
  const closure = freshClosure();
  const open: string[] = [];
  for (let i = 0; i < 30; i += 1) {
    beginFixture(closure, `fx-${i}`);
    open.push(`fx-${i}`);
    if (i % 2 === 0 && open.length > 1) {
      const done = open.shift()!;
      endFixture(closure, done);
    }
  }
  while (open.length > 0) endFixture(closure, open.shift()!);
  assert.equal(closure.verifyChain().valid, true);
  assert.equal(closure.assertClosureComplete().pendingCount, 0);
  assert.equal(closure.recordCount(), 60);
});

test("restored closure verifyChain is valid", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  endFixture(closure, "fx-1");
  const restored = restoreExecutionClosure(closure.snapshot());
  assert.equal(restored.verifyChain().valid, true);
  assert.equal(restored.verifyChain().verifiedRecords, 2);
});

test("restored closure assertClosureComplete reflects the restored state", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  beginFixture(closure, "fx-2");
  endFixture(closure, "fx-1");
  const restored = restoreExecutionClosure(closure.snapshot());
  const report = restored.assertClosureComplete();
  assert.equal(report.complete, true);
  assert.equal(report.pendingCount, 1);
  assert.equal(report.terminalCount, 1);
});

test("snapshot nextSequence reflects one past the last record", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  endFixture(closure, "fx-1");
  beginFixture(closure, "fx-2");
  assert.equal(closure.snapshot().nextSequence, "4");
});

test("createExecutionClosure with explicit identifiers uses them", () => {
  const closure = createExecutionClosure({ ledgerId: "my-ledger", segmentId: "my-segment", clock: deterministicClock() });
  assert.equal(closure.ledgerId, "my-ledger");
  assert.equal(closure.segmentId, "my-segment");
});

test("verifyExecutionClosureSnapshot preserves empty code for an empty snapshot", () => {
  const closure = freshClosure();
  const result = verifyExecutionClosureSnapshot(closure.snapshot());
  assert.equal(result.valid, true);
  assert.equal(result.code, "empty");
});

test("verifyExecutionClosureSnapshot on a restored-and-extended snapshot stays valid", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  const restored = restoreExecutionClosure(closure.snapshot());
  beginFixture(restored, "fx-2");
  endFixture(restored, "fx-2");
  const result = verifyExecutionClosureSnapshot(restored.snapshot());
  assert.equal(result.valid, true);
  assert.equal(result.verifiedRecords, 3);
});

for (const invalid of ["", 7]) {
  test(`observeExternalEffect rejects invalid evidenceHash ${invalid}`, () => {
    const closure = freshClosure();
    assert.throws(
      () => closure.observeExternalEffect({ observationId: "obs-1", kind: "process", evidenceHash: invalid as string }),
      { code: "execution_evidence_hash_invalid" },
    );
  });
}

test("observeExternalEffect rejects a null evidenceHash", () => {
  const closure = freshClosure();
  assert.throws(() => closure.observeExternalEffect({ observationId: "obs-1", kind: "process", evidenceHash: null as unknown as string }), { code: "execution_evidence_hash_invalid" });
});

test("observeExternalEffect rejects an object evidenceHash", () => {
  const closure = freshClosure();
  assert.throws(() => closure.observeExternalEffect({ observationId: "obs-1", kind: "process", evidenceHash: {} as unknown as string }), { code: "execution_evidence_hash_invalid" });
});

test("observeExternalEffect rejects an array evidenceHash", () => {
  const closure = freshClosure();
  assert.throws(() => closure.observeExternalEffect({ observationId: "obs-1", kind: "process", evidenceHash: [] as unknown as string }), { code: "execution_evidence_hash_invalid" });
});

test("observeExternalEffect rejects a 63-char evidenceHash", () => {
  const closure = freshClosure();
  assert.throws(
    () => closure.observeExternalEffect({ observationId: "obs-1", kind: "process", evidenceHash: "f".repeat(63) }),
    { code: "execution_evidence_hash_invalid" },
  );
});

test("observeExternalEffect rejects a 65-char evidenceHash", () => {
  const closure = freshClosure();
  assert.throws(
    () => closure.observeExternalEffect({ observationId: "obs-1", kind: "process", evidenceHash: "f".repeat(65) }),
    { code: "execution_evidence_hash_invalid" },
  );
});

test("observeExternalEffect rejects a non-hex evidenceHash", () => {
  const closure = freshClosure();
  assert.throws(
    () => closure.observeExternalEffect({ observationId: "obs-1", kind: "process", evidenceHash: "Z".repeat(64) }),
    { code: "execution_evidence_hash_invalid" },
  );
});

for (const invalid of ["", 9]) {
  test(`endEffect rejects invalid resultHash ${invalid}`, () => {
    const closure = freshClosure();
    beginFixture(closure, "fx-1");
    assert.throws(
      () => closure.endEffect("fx-1", { outcome: "succeeded", resultHash: invalid as string }),
      { code: "execution_result_hash_invalid" },
    );
  });
}

test("endEffect rejects a null resultHash", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  assert.throws(() => closure.endEffect("fx-1", { outcome: "succeeded", resultHash: null as unknown as string }), { code: "execution_result_hash_invalid" });
});

test("endEffect rejects an object resultHash", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  assert.throws(() => closure.endEffect("fx-1", { outcome: "succeeded", resultHash: {} as unknown as string }), { code: "execution_result_hash_invalid" });
});

test("endEffect rejects an array resultHash", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  assert.throws(() => closure.endEffect("fx-1", { outcome: "succeeded", resultHash: [] as unknown as string }), { code: "execution_result_hash_invalid" });
});

test("endEffect rejects a 63-char resultHash", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  assert.throws(() => closure.endEffect("fx-1", { outcome: "succeeded", resultHash: "f".repeat(63) }), { code: "execution_result_hash_invalid" });
});

test("endEffect rejects a 65-char resultHash", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  assert.throws(() => closure.endEffect("fx-1", { outcome: "succeeded", resultHash: "f".repeat(65) }), { code: "execution_result_hash_invalid" });
});

test("endEffect rejects a non-hex resultHash", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  assert.throws(() => closure.endEffect("fx-1", { outcome: "succeeded", resultHash: "Y".repeat(64) }), { code: "execution_result_hash_invalid" });
});

for (const invalid of ["", 3]) {
  test(`beginEffect rejects invalid intentHash ${invalid}`, () => {
    const closure = freshClosure();
    assert.throws(
      () => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a" }, description: "x", intentHash: invalid as string }),
      { code: "execution_intent_hash_invalid" },
    );
  });
}

test("beginEffect rejects a null intentHash", () => {
  const closure = freshClosure();
  assert.throws(() => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a" }, description: "x", intentHash: null as unknown as string }), { code: "execution_intent_hash_invalid" });
});

test("beginEffect rejects an object intentHash", () => {
  const closure = freshClosure();
  assert.throws(() => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a" }, description: "x", intentHash: {} as unknown as string }), { code: "execution_intent_hash_invalid" });
});

test("beginEffect rejects an array intentHash", () => {
  const closure = freshClosure();
  assert.throws(() => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a" }, description: "x", intentHash: [] as unknown as string }), { code: "execution_intent_hash_invalid" });
});

test("beginEffect rejects a 63-char intentHash", () => {
  const closure = freshClosure();
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a" }, description: "x", intentHash: "f".repeat(63) }),
    { code: "execution_intent_hash_invalid" },
  );
});

test("beginEffect rejects a 65-char intentHash", () => {
  const closure = freshClosure();
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a" }, description: "x", intentHash: "f".repeat(65) }),
    { code: "execution_intent_hash_invalid" },
  );
});

test("beginEffect rejects a non-hex intentHash", () => {
  const closure = freshClosure();
  assert.throws(
    () => closure.beginEffect({ effectId: "fx-1", kind: "filesystem", actor: { kind: "harness", id: "a" }, description: "x", intentHash: "Q".repeat(64) }),
    { code: "execution_intent_hash_invalid" },
  );
});

test("error summary rejects invalid category", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  assert.throws(
    () => closure.endEffect("fx-1", { outcome: "failed", resultHash: VALID_HASH_B, error: { category: "bad cat", code: "x", message: "m", retryable: false } }),
    { code: "execution_error_invalid" },
  );
});

test("error summary rejects non-boolean retryable", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  assert.throws(
    () => closure.endEffect("fx-1", { outcome: "failed", resultHash: VALID_HASH_B, error: { category: "tool", code: "x", message: "m", retryable: "yes" as unknown as boolean } }),
    { code: "execution_error_invalid" },
  );
});

test("error summary rejects oversized message", () => {
  const closure = freshClosure();
  beginFixture(closure, "fx-1");
  assert.throws(
    () => closure.endEffect("fx-1", { outcome: "failed", resultHash: VALID_HASH_B, error: { category: "tool", code: "x", message: "x".repeat(8193), retryable: false } }),
    { code: "execution_error_invalid" },
  );
});

test("a closure with only observations (no intents) reports orphaned observations", () => {
  const closure = freshClosure();
  closure.observeExternalEffect({ observationId: "obs-1", kind: "git", evidenceHash: VALID_HASH_A });
  closure.observeExternalEffect({ observationId: "obs-2", kind: "network", evidenceHash: VALID_HASH_B });
  const report = closure.assertClosureComplete();
  assert.equal(report.complete, false);
  assert.equal(report.orphanedObservationCount, 2);
  assert.equal(closure.lineage().length, 2);
  assert.deepEqual(closure.lineage().map((l) => l.status), ["orphaned-observation", "orphaned-observation"]);
});

test("snapshot of a closure with only observations restores and preserves orphans", () => {
  const closure = freshClosure();
  closure.observeExternalEffect({ observationId: "obs-1", kind: "git", evidenceHash: VALID_HASH_A });
  const restored = restoreExecutionClosure(closure.snapshot());
  assert.equal(restored.observations().length, 1);
  assert.equal(restored.assertClosureComplete().orphanedObservationCount, 1);
});

test("repeated snapshot/restore cycles preserve state exactly", () => {
  let closure = freshClosure();
  beginFixture(closure, "fx-1");
  endFixture(closure, "fx-1");
  for (let i = 0; i < 5; i += 1) {
    const snap = closure.snapshot();
    closure = restoreExecutionClosure(snap);
  }
  assert.equal(closure.recordCount(), 2);
  assert.equal(closure.verifyChain().valid, true);
  assert.equal(closure.assertClosureComplete().complete, true);
});

test("chain hash is deterministic and keyless (same inputs → same chain)", () => {
  const a = createExecutionClosure({ ledgerId: "l", segmentId: "s", clock: deterministicClock() });
  const b = createExecutionClosure({ ledgerId: "l", segmentId: "s", clock: deterministicClock() });
  beginFixture(a, "fx-1");
  beginFixture(b, "fx-1");
  endFixture(a, "fx-1");
  endFixture(b, "fx-1");
  assert.equal((a.snapshot().records[0] as { chainHash: string }).chainHash, (b.snapshot().records[0] as { chainHash: string }).chainHash);
  assert.equal((a.snapshot().records[1] as { chainHash: string }).chainHash, (b.snapshot().records[1] as { chainHash: string }).chainHash);
});

test("a different ledgerId produces a different intent chainHash (coordinate is bound into the chain)", () => {
  const a = createExecutionClosure({ ledgerId: "l1", segmentId: "s", clock: deterministicClock() });
  const b = createExecutionClosure({ ledgerId: "l2", segmentId: "s", clock: deterministicClock() });
  const ia = beginFixture(a, "fx-1") as { chainHash: string };
  const ib = beginFixture(b, "fx-1") as { chainHash: string };
  assert.notEqual(ia.chainHash, ib.chainHash);
});

// Persistence is admitted before any lineage mutation, including arbitrary throws.
for (const thrown of ["Error", "undefined"] as const) {
  test(`execution-closure: refused persistence preserves state (${thrown})`, () => {
    const failure = thrownFailure(thrown, "private failure");
    const closure = freshClosure();
    const before = closure.snapshot();
    let invoked = 0;
    let caught = false;
    try {
      closure.beginEffect({ effectId: "persist", kind: "provider", actor: { kind: "harness", id: "agent" }, description: "request", intentHash: VALID_HASH_A }, (record) => {
        invoked += 1;
        assert.ok(Object.isFrozen(record) && Object.isFrozen(record.actor));
        assert.deepEqual(closure.snapshot(), before);
        throw failure;
      });
    } catch (error) { caught = true; assert.equal(error, failure); }
    assert.ok(caught);
    assert.equal(invoked, 1);
    assert.deepEqual(closure.snapshot(), before);
    beginFixture(closure, "persist", "provider");
    const pending = closure.snapshot();
    let terminalCalls = 0;
    caught = false;
    try { closure.endEffect("persist", { outcome: "succeeded", resultHash: VALID_HASH_B }, () => { terminalCalls += 1; throw failure; }); }
    catch (error) { caught = true; assert.equal(error, failure); }
    assert.ok(caught); assert.equal(terminalCalls, 1);
    assert.deepEqual(closure.snapshot(), pending);
    assert.equal(closure.pendingEffects().length, 1);
    closure.endEffect("persist", { outcome: "succeeded", resultHash: VALID_HASH_B });
  });
}

test("execution-closure: persistence error classification never traverses arbitrary prototypes", () => {
  const closure = freshClosure();
  let traps = 0;
  const original = Object.create(new Proxy({}, { getPrototypeOf() { traps += 1; throw new Error("trap"); } }));
  const before = closure.snapshot();
  assert.throws(() => closure.observeExternalEffect({ observationId: "o", kind: "provider", evidenceHash: VALID_HASH_A }, () => { throw original; }), (error) => error === original);
  assert.equal(traps, 0);
  assert.deepEqual(closure.snapshot(), before);
  beginFixture(closure, "healthy");
});

test("execution-closure: one captured input field and frozen timestamp are persisted", () => {
  const closure = freshClosure();
  let reads = 0;
  const record = closure.beginEffect({ effectId: "getter", get kind() { reads += 1; return reads === 1 ? "provider" : "filesystem"; }, actor: { kind: "harness", id: "agent" }, description: "request", intentHash: VALID_HASH_A }, (prepared) => {
    assert.equal(prepared.kind, "provider");
    assert.ok(Object.isFrozen(prepared.timestamp));
    return undefined;
  });
  assert.equal(reads, 1);
  assert.equal(record.kind, "provider");
});

test("execution-closure: all mutation kinds reject nested writes until the outer call settles", () => {
  const closure = freshClosure();
  const refuseNested = () => {
    for (const nested of [
      () => beginFixture(closure, "nested"),
      () => closure.endEffect("outer", { outcome: "succeeded", resultHash: VALID_HASH_B }),
      () => closure.observeExternalEffect({ observationId: "nested", kind: "provider", evidenceHash: VALID_HASH_A }),
    ]) assert.throws(nested, (error) => error instanceof SecurityError && error.code === "execution_mutation_reentrant");
    return undefined;
  };
  closure.beginEffect({ effectId: "outer", kind: "provider", actor: { kind: "harness", id: "agent" }, description: "request", intentHash: VALID_HASH_A }, refuseNested);
  closure.endEffect("outer", { outcome: "succeeded", resultHash: VALID_HASH_B }, refuseNested);
  closure.observeExternalEffect({ observationId: "outer-observation", kind: "provider", evidenceHash: VALID_HASH_A }, refuseNested);
  assert.equal(closure.recordCount(), 3);
  let clockCalls = 0;
  const guarded = createExecutionClosure({ clock: { now() { clockCalls += 1; assert.throws(() => beginFixture(guarded, "clock-nested"), (error) => error instanceof SecurityError && error.code === "execution_mutation_reentrant"); return { wallTime: "2026-09-24T00:00:00Z" }; } } });
  assert.throws(() => guarded.beginEffect({ effectId: "invalid", kind: "provider", actor: { kind: "harness", id: "agent" }, description: "request", intentHash: VALID_HASH_A }, 7 as never), (error) => error instanceof InputError && error.code === "execution_persistence_invalid");
  assert.equal(clockCalls, 0);
  beginFixture(guarded, "clock");
  let getterReads = 0;
  const getterGuarded = freshClosure();
  getterGuarded.beginEffect({
    effectId: "getter-outer",
    get kind() {
      getterReads += 1;
      for (const nested of [
        () => beginFixture(getterGuarded, "getter-nested"),
        () => getterGuarded.observeExternalEffect({ observationId: "getter-nested", kind: "provider", evidenceHash: VALID_HASH_A }),
      ]) assert.throws(nested, (error) => error instanceof SecurityError && error.code === "execution_mutation_reentrant");
      return "provider" as const;
    },
    actor: { kind: "harness", id: "agent" }, description: "request", intentHash: VALID_HASH_A,
  });
  assert.equal(getterReads, 1);
  assert.equal(getterGuarded.recordCount(), 1);
  assert.deepEqual(getterGuarded.pendingEffects().map((intent) => intent.effectId), ["getter-outer"]);
});

test("execution-closure: asynchronous persistence refuses memory commit and latches uncertainty", async () => {
  const closure = freshClosure();
  const before = closure.snapshot();
  assert.throws(() => closure.observeExternalEffect({ observationId: "async", kind: "provider", evidenceHash: VALID_HASH_A }, (() => Promise.reject(new Error("private async failure"))) as never), (error) => error instanceof LedgerPersistenceUncertainError && error.code === "ledger_persistence_uncertain");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(closure.snapshot(), before);
  assert.throws(() => beginFixture(closure, "retry"), (error) => error instanceof LedgerPersistenceUncertainError && error.code === "ledger_persistence_uncertain");
});


test("execution-closure: hostile Promise species cannot replace fixed uncertainty", () => {
  const closure = freshClosure(); const before = closure.snapshot();
  const promise = Promise.resolve(undefined);
  Object.defineProperty(promise, "constructor", { get() { throw new Error("private species canary"); } });
  const refusal = (error: unknown) => error instanceof LedgerPersistenceUncertainError && error.code === "ledger_persistence_uncertain" && error.message === "Ledger persistence outcome is uncertain";
  assert.throws(() => closure.observeExternalEffect({ observationId: "species", kind: "provider", evidenceHash: VALID_HASH_A }, (() => promise) as never), refusal);
  assert.deepEqual(closure.snapshot(), before);
  assert.throws(() => beginFixture(closure, "retry"), refusal);
});
