// @vitest-environment node
/**
 * THE ARM FIRING ENGINE — the grammar half + the firing OUTCOMES (§6.4).
 *
 * The invariants this file owns:
 *   - the vocabulary context binds ONLY what the live stream genuinely
 *     carries (a tool event's `tool:<name>` description + outcome; a check
 *     delta's `check:<name> <from>→<to>` description; the event's own
 *     columns; the last-known context as a standing gauge);
 *   - a grammar predicate fires single-shot at the matching event, and a
 *     second matching event does NOT re-fire (the single-shot law);
 *   - a pure-context predicate never fires per-event — the COMPOSE door
 *     (a run's context report) owns it, firing at the measurement's
 *     arrival (the context-crosses wiring: evalContextCross's first
 *     caller);
 *   - a firing DOCKS THE FINDING with its mandatory derivation and the two
 *     verbs (go — the band seam; re-arm — restoring cocked state);
 *   - an absent binding (tool.durationMs waits on the timing feed) makes
 *     the predicate evaluate honestly false, never throw, never fire.
 */
import { beforeEach, describe, expect, test } from "vitest";

import {
  armedTriggers,
  armTrigger,
  fireMatchingArms,
  nowEdge,
  reArmTrigger,
  recordContextReading,
  resetSweep,
  sweepMarks,
} from "../../src/cockpit/sweep/sweep-store";
import {
  ARM_FIELD_EVALUATION_DEFAULT,
  ARM_UNBOUND_FIELDS,
  armEventContext,
  armFieldEvaluation,
  armFiredVerbs,
  announceArmCapture,
  evalArmGrammar,
  isPureContextPredicate,
} from "../../src/cockpit/sweep/arm-fire";
import { consumeBandGoRequest } from "../../src/cockpit/sweep/band-request";
import { formatClock } from "../../src/cockpit/sweep/now-edge";
import { scoreCandidate } from "../../src/cockpit/computer/admission";
import { armVocabularyFields } from "../../shared/arm-vocabulary";
import { parseArms } from "../../src/cockpit/sweep/marks";
import { deskLine, resetAdmission } from "../../src/cockpit/computer/admission";
import {
  appendAssistantMessage,
  clearMessages,
  messages,
  updateLastAssistantMessage,
} from "../../src/state/chat-messages";
import type { SweepEvent } from "../../src/cockpit/sweep/types";

const ev = (timeMs: number, extra: Partial<SweepEvent> = {}): SweepEvent => ({
  eventId: extra.eventId ?? `e${timeMs}`,
  timeMs,
  category: extra.category ?? "tool",
  isError: extra.isError ?? false,
  eventType: extra.eventType ?? "tool",
  outcome: extra.outcome ?? null,
  errorCode: extra.errorCode ?? null,
  runId: extra.runId !== undefined ? extra.runId : "r1",
  turnId: null,
  parentEventId: null,
  description: extra.description ?? "",
});

/** A run's context report exactly as the SSE wire serves it. */
function contextReport(pct: number): { systemPrompt: string; toolNames: string[]; historyLength: number; contextTokens: number; contextTokenLimit: number } {
  const limit = 100_000;
  return {
    systemPrompt: "s",
    toolNames: [],
    historyLength: 1,
    contextTokens: Math.round((pct / 100) * limit),
    contextTokenLimit: limit,
  };
}

beforeEach(() => {
  resetSweep();
  sweepMarks.set([]);
  armedTriggers.set([]);
  resetAdmission();
});

describe("the vocabulary context — bound only from what the stream carries", () => {
  test("a tool event binds tool.name (the tool: description parse) and tool.failed (the outcome)", () => {
    const ctx = armEventContext(ev(1, { eventType: "tool", description: "tool:edit", outcome: "failed" }));
    expect(ctx.tool).toEqual({ name: "edit", failed: true });
    const ok = armEventContext(ev(1, { eventType: "tool", description: "tool:edit", outcome: "succeeded" }));
    expect(ok.tool).toEqual({ name: "edit", failed: false });
    // An event that is not a tool frame binds NO tool root.
    const none = armEventContext(ev(1, { eventType: "run", description: "run finished: stop" }));
    expect(none.tool).toBeUndefined();
  });

  test("a check delta binds check.id and check.status (the check: description parse)", () => {
    const ctx = armEventContext(
      ev(1, { eventType: "quality", description: "check:lint passed→failed", category: "safety" }),
    );
    expect(ctx.check).toEqual({ id: "lint", status: "failed" });
    const first = armEventContext(
      ev(1, { eventType: "quality", description: "check:lint unrecorded→passed", category: "safety" }),
    );
    expect(first.check).toEqual({ id: "lint", status: "passed" });
  });

  test("the event's own columns bind verbatim; absent columns are ABSENT, not invented", () => {
    const ctx = armEventContext(
      ev(1, { eventType: "error", outcome: "denied", errorCode: "tool_gate_loop", description: "blocked" }),
    );
    expect(ctx.event).toMatchObject({ type: "error", outcome: "denied", errorCode: "tool_gate_loop", description: "blocked" });
    const bare = armEventContext(ev(1, { eventType: "context" }));
    expect(bare.event).not.toHaveProperty("outcome");
    expect(bare.event).not.toHaveProperty("errorCode");
  });

  test("an unparseable predicate evaluates false, never throws — the arm door owns refusals", () => {
    expect(evalArmGrammar("this is (not a predicate", ev(1))).toBe(false);
  });

  // ── THE RUNTIME-BINDING PIN ── the palette's derived field set must equal
  // the fields the firing engine actually BINDS at runtime, plus exactly
  // the declared honest-absence set. A description edit that offers an
  // unbindable field would arm a trigger that evaluates honestly-false
  // forever while wearing the "evaluates live" sentence — the pin reds on
  // the mismatch instead; a runtime binding no description enumerates is
  // silently unofferable and reds the same equality from the other side.
  test("the palette's derived fields == the runtime-bound fields + exactly the declared absent set", () => {
    // Bind EVERY branch the context has: a full-column event, a tool frame,
    // a check delta, and the standing context gauge (seeded through the
    // transcript the gauge derives from).
    clearMessages();
    const withContext = appendAssistantMessage("a run's context report");
    updateLastAssistantMessage((m) => ({
      ...m,
      context: {
        systemPrompt: "s",
        toolNames: [],
        historyLength: 1,
        contextTokens: 40_000,
        contextTokenLimit: 100_000,
      },
    }));
    const contexts = [
      armEventContext(ev(1, { eventType: "error", outcome: "denied", errorCode: "tool_gate_loop", description: "blocked", runId: "r1" })),
      armEventContext(ev(2, { eventType: "tool", description: "tool:edit", outcome: "failed" })),
      armEventContext(ev(3, { eventType: "quality", description: "check:lint passed→failed", category: "safety" })),
    ];
    clearMessages();
    const bound = new Set<string>();
    for (const ctx of contexts) {
      for (const [root, fields] of Object.entries(ctx)) {
        for (const field of Object.keys(fields as Record<string, unknown>)) {
          bound.add(`${root}.${field}`);
        }
      }
    }
    const offered = armVocabularyFields().map((f) => f.path);
    // The equality is the pin: everything offered is either bound at runtime
    // or declared honestly absent — and everything bound is offered (a
    // runtime binding no description enumerates reds from the other side).
    const expectedBound = offered
      .filter((p) => !ARM_UNBOUND_FIELDS.has(p))
      .sort();
    expect([...bound].sort()).toEqual(expectedBound);
  });

  test("the declared absent set stays honest: every member is a live vocabulary field with its own non-live disclosure", () => {
    const offered = new Set(armVocabularyFields().map((f) => f.path));
    for (const path of ARM_UNBOUND_FIELDS) {
      expect(offered.has(path), `"${path}" is declared unbound but the palette does not offer it`).toBe(true);
      expect(armFieldEvaluation(path)).not.toBe(ARM_FIELD_EVALUATION_DEFAULT);
    }
  });
});

describe("grammar arms fire single-shot at the matching event", () => {
  test("a named-tool predicate fires on that tool's failure — and only once (the single-shot law)", () => {
    const t = armTrigger("custom", "tool.name == 'edit' && tool.failed", "tool.name == 'edit' && tool.failed");
    const dropped = fireMatchingArms(ev(4000, { eventType: "tool", description: "tool:edit", outcome: "failed", isError: true }));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.timeMs).toBe(4000);
    expect(dropped[0]!.label).toContain("tool.name == 'edit'");
    expect(armedTriggers.get()[0]!.firedAtMs).toBe(4000);
    // single-shot: a second matching event does not re-fire.
    expect(fireMatchingArms(ev(5000, { eventType: "tool", description: "tool:edit", outcome: "failed", isError: true }))).toHaveLength(0);
    expect(sweepMarks.get().filter((m) => m.origin === "arm")).toHaveLength(1);
    void t;
  });

  test("a named-tool predicate does NOT fire on another tool's failure", () => {
    armTrigger("custom", "tool.name == 'edit' && tool.failed", "tool.name == 'edit' && tool.failed");
    expect(
      fireMatchingArms(ev(1, { eventType: "tool", description: "tool:read_file", outcome: "failed", isError: true })),
    ).toHaveLength(0);
  });

  test("a named-check predicate fires on that check's failure delta", () => {
    armTrigger("custom", "check.id == 'lint' && check.status == 'failed'", "check.id == 'lint' && check.status == 'failed'");
    const dropped = fireMatchingArms(
      ev(4000, { eventType: "quality", description: "check:lint passed→failed", category: "safety" }),
    );
    expect(dropped).toHaveLength(1);
  });

  test("a denied-outcome predicate fires on a denied event", () => {
    armTrigger("custom", "event.outcome == 'denied'", "event.outcome == 'denied'");
    const dropped = fireMatchingArms(ev(4000, { eventType: "error", outcome: "denied", category: "safety" }));
    expect(dropped).toHaveLength(1);
  });

  test("a run-boundary predicate fires on the run event", () => {
    armTrigger("custom", "event.type == 'run'", "event.type == 'run'");
    const dropped = fireMatchingArms(ev(4000, { eventType: "run", description: "run finished: stop", category: "lifecycle" }));
    expect(dropped).toHaveLength(1);
  });

  test("an absent binding (tool.durationMs waits on the timing feed) evaluates honestly false — never fires, never throws", () => {
    armTrigger("custom", "tool.durationMs >= 100", "tool.durationMs >= 100");
    expect(fireMatchingArms(ev(1, { eventType: "tool", description: "tool:edit", outcome: "succeeded" }))).toHaveLength(0);
    expect(armedTriggers.get()[0]!.firedAtMs).toBeNull();
  });
});

describe("the storage seam — a legacy row cannot kill the firing pass", () => {
  // REPRODUCED LIVE (this round's drive): a row stored before `predicate` and
  // `scope` existed round-trips those keys ABSENT, and admission without
  // normalization left `predicate: undefined` in the atom. The firing
  // engine's `t.predicate !== null` read that as "has an expression" and
  // handed the missing string to the grammar, which THREW — killing the
  // firing pass for every row on every received event, while the now edge
  // had already moved (the receipt looked live, nothing ever fired).
  test("parseArms normalizes a legacy row: the firing pass survives and the grammar row still fires", () => {
    const raw = JSON.stringify([
      { id: "arm-legacy-fixed", kind: "check-fails", param: null, armedAtMs: 1, firedAtMs: null, storage: "ledger" },
      {
        id: "arm-legacy-grammar", kind: "custom", param: "tool.name == 'read_file' && tool.failed",
        predicate: "tool.name == 'read_file' && tool.failed", scope: "all",
        armedAtMs: 2, firedAtMs: null, storage: "ledger",
      },
    ]);
    const rows = parseArms(raw);
    expect(rows).not.toBeNull();
    // The declared shape is RESTORED at the boundary, not just tolerated:
    expect(rows![0]!.predicate).toBeNull();
    expect(rows![0]!.scope).toBe("chat");
    armedTriggers.set(Object.freeze(rows!));
    const dropped = fireMatchingArms(
      ev(4000, { eventId: "live-1", eventType: "tool", description: "tool:read_file", outcome: "failed", isError: true }),
    );
    expect(dropped).toHaveLength(1);
    expect(armedTriggers.get().find((r) => r.id === "arm-legacy-grammar")!.firedAtMs).toBe(4000);
    expect(armedTriggers.get().find((r) => r.id === "arm-legacy-fixed")!.firedAtMs).toBeNull();
  });

  test("a foreign-tab arms blob adopted mid-session is normalized the same way", () => {
    const raw = JSON.stringify([
      { id: "arm-foreign-fixed", kind: "tool-errors", param: null, armedAtMs: 1, firedAtMs: null, storage: "local" },
    ]);
    const rows = parseArms(raw);
    expect(rows).not.toBeNull();
    expect(rows![0]!.predicate).toBeNull();
    expect(rows![0]!.scope).toBe("chat");
  });
});

describe("the firing docks the finding (the design's own promise, with its derivation)", () => {
  test("a firing proposes the desk-line finding: the sentence, the derivation naming the trigger's address, and the two verbs", () => {
    armTrigger("custom", "tool.name == 'edit' && tool.failed", "tool.name == 'edit' && tool.failed");
    fireMatchingArms(ev(4000, { eventType: "tool", description: "tool:edit", outcome: "failed", isError: true }));
    const docked = deskLine.get();
    expect(docked).not.toBeNull();
    expect(docked!.finding.findingKind).toBe("arm-fired");
    expect(docked!.finding.sentence).toContain("armed trigger fired");
    expect(docked!.finding.sentence).toContain("open at that moment");
    // The derivation states the trigger's address + the event — nothing copied.
    expect(docked!.finding.derivation.steps.some((s) => s.sourceId === `sweep.arms/${armedTriggers.get()[0]!.id}`)).toBe(true);
    expect(docked!.finding.derivation.steps.some((s) => s.sourceId === "e4000")).toBe(true);
    expect(docked!.finding.derivation.asOf).toBe(4000);
    // The verbs: go (a read) + re-arm (a write).
    const verbs = docked!.finding.verbs ?? [];
    expect(verbs.map((v) => v.id)).toEqual(["sweep.arm-go", "sweep.re-arm"]);
    expect(verbs[0]!.writes).toBe(false);
    expect(verbs[1]!.writes).toBe(true);
  });

  test("the re-arm verb restores cocked state — the trigger fires again on the next match", () => {
    const t = armTrigger("custom", "event.outcome == 'denied'", "event.outcome == 'denied'");
    fireMatchingArms(ev(4000, { eventType: "error", outcome: "denied", category: "safety" }));
    expect(armedTriggers.get()[0]!.firedAtMs).toBe(4000);
    // The verb's own run is the re-arm door.
    const verbs = armFiredVerbs(armedTriggers.get()[0]!, 4000);
    verbs[1]!.run!();
    expect(armedTriggers.get()[0]!.firedAtMs).toBeNull();
    // Re-cocked: the next matching event fires (a NEW arming).
    const second = fireMatchingArms(ev(6000, { eventType: "error", outcome: "denied", category: "safety" }));
    expect(second).toHaveLength(1);
    expect(second[0]!.timeMs).toBe(6000);
    void t;
  });

  test("re-arm on a cocked row is a no-op (it is already waiting)", () => {
    armTrigger("tool-errors");
    expect(reArmTrigger(armedTriggers.get()[0]!.id)).toBeNull();
    expect(reArmTrigger("no-such-row")).toBeNull();
  });
});

describe("the capture→finding share (the campaign's standing item, landed)", () => {
  test("sharing a capture docks the finding through the ONE admission door, with the derivation naming the capture's own address", () => {
    announceArmCapture({ id: "flag-cap-1", t0: 1788_000_000_000, t1: 1788_000_120_000, label: "the relay flap window" });
    const docked = deskLine.get();
    expect(docked).not.toBeNull();
    expect(docked!.finding.findingKind).toBe("arm-capture");
    expect(docked!.finding.sentence).toContain("capture shared: the relay flap window");
    expect(docked!.finding.sentence).toContain("open at that moment");
    // The derivation states the ADDRESS — the record's flag id and the
    // band's stretch — nothing copied.
    expect(docked!.finding.derivation.steps).toEqual([
      { source: "the captured stretch", sourceId: "arm.flags/capture flag-cap-1", count: 1 },
    ]);
    expect(docked!.finding.derivation.asOf).toBe(1788_000_000_000);
    expect(docked!.finding.derivation.window).toBe(
      `the band from ${formatClock(1788_000_000_000)} to ${formatClock(1788_000_120_000)}`,
    );
    // THE ADMISSION CONTRACT: the share scores as the reader's own request
    // (the arm-fired class), never the unregistered-kind default.
    expect(scoreCandidate({ finding: docked!.finding })).toBe(55);
  });

  test("the share's one verb is the same read a capture row's label runs — the band seam, at the stretch's start", () => {
    announceArmCapture({ id: "flag-cap-2", t0: 1788_000_500_000, t1: 1788_000_900_000, label: "unnamed" });
    const docked = deskLine.get();
    expect(docked).not.toBeNull();
    const verbs = docked!.finding.verbs ?? [];
    expect(verbs.map((v) => v.id)).toEqual(["sweep.capture-go"]);
    expect(verbs[0]!.label).toBe("open at that moment");
    expect(verbs[0]!.writes).toBe(false);
    verbs[0]!.run!();
    // The band seam carries the ask — the same one-shot atom a capture
    // row's go writes, read back through the sweep's own consume door.
    expect(consumeBandGoRequest()).toBe(1788_000_500_000);
    expect(consumeBandGoRequest(), "the seam is one-shot — a second consume finds it empty").toBeNull();
  });

  test("an unnamed stretch shares under its own honest name; a capture with no address shares nothing", () => {
    announceArmCapture({ id: "flag-cap-3", t0: 5, t1: 9 });
    let docked = deskLine.get();
    expect(docked!.finding.sentence).toContain("capture shared: an unnamed stretch");
    expect(docked!.finding.derivation.asOf).toBe(5);
    // The wire's optional shape: no t0 means no address, and a finding whose
    // derivation cannot name where it lives is not proposed at all — the
    // caller renders the verb only where the address exists, and this guard
    // is the promise the caller leans on.
    resetAdmission();
    announceArmCapture({ id: "flag-cap-4", label: "a stretch with no address" });
    docked = deskLine.get();
    expect(docked, "a capture with no address shares nothing").toBeNull();
  });
});

describe("the compose door — context readings fire context triggers", () => {
  test("a pure-context predicate never fires per-event (the compose door owns it)", () => {
    expect(isPureContextPredicate("context.pct >= 80")).toBe(true);
    expect(isPureContextPredicate("event.type == 'run' && context.pct >= 80")).toBe(false);
    armTrigger("custom", "context.pct >= 80", "context.pct >= 80");
    // Ten events arrive while the gauge is high — the predicate does not
    // fire on any of them.
    for (let i = 0; i < 10; i += 1) {
      fireMatchingArms(ev(1000 + i, { eventType: "turn", category: "llm" }));
    }
    expect(armedTriggers.get()[0]!.firedAtMs).toBeNull();
  });

  test("the context-crosses KIND fires on a crossing compose report — once (its first caller)", () => {
    armTrigger("context-crosses", "80");
    const dropped = recordContextReading(contextReport(85));
    expect(dropped).toHaveLength(1);
    expect(armedTriggers.get()[0]!.firedAtMs).not.toBeNull();
    // The context firing mark's identity is (row, generation) — stated as
    // the value the id must carry, so the same measurement firing in two
    // tabs collapses to one persisted mark (a re-armed generation stamps a
    // new armedAtMs and stays unique).
    expect(dropped[0]!.id).toBe(
      `mark-context-${armedTriggers.get()[0]!.id}-${armedTriggers.get()[0]!.armedAtMs}`,
    );
    // single-shot: a second crossing report does not re-fire.
    expect(recordContextReading(contextReport(90))).toHaveLength(0);
  });

  test("a pure-context GRAMMAR predicate fires on the crossing report, with the finding naming the measurement", () => {
    armTrigger("custom", "context.pct >= 80", "context.pct >= 80");
    const dropped = recordContextReading(contextReport(85));
    expect(dropped).toHaveLength(1);
    const docked = deskLine.get();
    expect(docked!.finding.derivation.method).toContain("context measurement");
    expect(docked!.finding.derivation.steps.some((s) => s.sourceId === "run context event")).toBe(true);
  });

  test("a report with no usable measurement (no limit) fires nothing — absence is not a crossing", () => {
    armTrigger("context-crosses", "80");
    const dropped = recordContextReading({
      systemPrompt: "s",
      toolNames: [],
      historyLength: 1,
      contextTokens: 50_000,
    });
    expect(dropped).toHaveLength(0);
    expect(armedTriggers.get()[0]!.firedAtMs).toBeNull();
  });

  test("a reading below the threshold does not fire, and the receipt still ticks the now edge", () => {
    armTrigger("context-crosses", "80");
    const before = nowEdge.get().timeMs;
    const dropped = recordContextReading(contextReport(12));
    expect(dropped).toHaveLength(0);
    // The context report is a genuinely received event: the edge advanced
    // (a real receipt, never a fabricated clock).
    expect(nowEdge.get().timeMs).not.toBe(before);
    expect(nowEdge.get().timeMs).not.toBeNull();
  });

  test("a mixed predicate (event + context) evaluates per-event with the LAST-KNOWN gauge", () => {
    // Feed the standing gauge the way the live wire does: a transcript
    // message carrying the run's context report.
    messages.set([
      {
        id: "m1",
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        context: contextReport(85),
      },
    ]);
    armTrigger("custom", "event.type == 'run' && context.pct >= 80", "event.type == 'run' && context.pct >= 80");
    const dropped = fireMatchingArms(ev(4000, { eventType: "run", description: "run finished: stop", category: "lifecycle" }));
    expect(dropped).toHaveLength(1);
    // The same predicate over an event while the gauge is UNMEASURED
    // binds no context → honestly false, never a throw.
    messages.set([]);
    armedTriggers.set([]);
    armTrigger("custom", "event.type == 'quality' && context.pct >= 80", "event.type == 'quality' && context.pct >= 80");
    expect(fireMatchingArms(ev(5000, { eventType: "quality", description: "check:lint passed→passed", category: "safety" }))).toHaveLength(0);
  });
});
