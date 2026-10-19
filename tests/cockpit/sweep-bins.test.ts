// @vitest-environment node
/**
 * SWEEP binning honesty (DESIGN-COCKPIT-V2 §6.1/§6.6): every bar traces to
 * real events, gaps render as gaps, error events feed the ridge only, and
 * the guards are MUTATION-TESTED — a fabricated bin count must fail.
 */
import { describe, expect, test } from "vitest";
import { join } from "node:path";

import {
  binEvents,
  binIndexFor,
  assertBinsHonest,
  assertBinsConsistent,
  eventCoverage,
} from "../../src/cockpit/sweep/bins";
import { SWEEP_CATEGORY_IDS, toSweepEvent } from "../../src/cockpit/sweep/categories";
import {
  SweepHonestyViolation,
  type SweepEvent,
  type SweepWindow,
} from "../../src/cockpit/sweep/types";
// The engine spectrum — the band's preferred source and the counting-policy
// owner. The agreement arm below drives the REAL store so the fallback's
// ridge is proven against the served error row over the same ledger rows.
import { createTimelineStore } from "../../engine/src/timeline/timeline-store.ts";
// The single owner of test temporary directories — creation and removal are
// fused in one call; the sqlite fixture below must not hand-roll its own.
import { createTempDir } from "../helpers/temp-dir";

function ev(partial: Partial<SweepEvent> & { timeMs: number }): SweepEvent {
  return {
    eventId: partial.eventId ?? `e-${partial.timeMs}-${Math.random()}`,
    timeMs: partial.timeMs,
    category: partial.category ?? "tool",
    isError: partial.isError ?? false,
    eventType: partial.eventType ?? "tool",
    outcome: null,
    errorCode: null,
    runId: partial.runId ?? "r1",
    turnId: partial.turnId ?? "t1",
    parentEventId: partial.parentEventId ?? null,
    description: partial.description ?? "",
  };
}

const W: SweepWindow = { t0: 0, t1: 1000 };

describe("binEvents", () => {
  test("conserves every in-window event exactly once", () => {
    const events = [
      ev({ timeMs: 0 }),
      ev({ timeMs: 250, category: "llm", eventType: "turn" }),
      ev({ timeMs: 500, isError: true }),
      ev({ timeMs: 999 }),
      ev({ timeMs: 1000 }), // right edge — clamps into last bin, not dropped
      ev({ timeMs: 1500 }), // outside — excluded
      ev({ timeMs: -1 }), // outside — excluded
    ];
    const bins = binEvents(events, W, 10);
    expect(bins.eventCount).toBe(5);
    expect(bins.totals.reduce((a, b) => a + b, 0)).toBe(5);
    assertBinsHonest(bins, events);
  });

  test("gaps stay zero — a quiet period is an empty bin, never interpolated", () => {
    const events = [ev({ timeMs: 50 }), ev({ timeMs: 950 })];
    const bins = binEvents(events, W, 10);
    for (let i = 1; i < 9; i++) expect(bins.totals[i]).toBe(0);
    expect(bins.totals[0]).toBe(1);
    expect(bins.totals[9]).toBe(1);
  });

  test("error events feed the ridge ONLY — never double-counted", () => {
    const events = [ev({ timeMs: 100, isError: true, category: "tool" })];
    const bins = binEvents(events, W, 10);
    expect(bins.errors[1]).toBe(1);
    const stackSum = bins.counts[1]!.reduce((a, b) => a + b, 0);
    expect(stackSum).toBe(0);
    expect(bins.totals[1]).toBe(1);
  });

  // ── THE RIDGE COUNTS INCIDENTS, NOT ERROR EVENTS ────────────────────────
  //
  // THE USER'S REPORT: one failed tool call showed as "2 with errors". A
  // gate-blocked call is recorded twice by design — the tool event (outcome
  // failed) plus the gate's inline `error` account (outcome denied, parented
  // to the tool event) — and the ridge must fold the pair into ONE. These
  // arms carry the exact incident from the ledger evidence.

  test("a gate-blocked tool call + its parented inline account = ONE ridge incident, two events", () => {
    const toolEvent = ev({
      eventId: "tool-1",
      timeMs: 100,
      isError: true,
      eventType: "tool",
      category: "tool",
      parentEventId: null,
    });
    const inlineAccount = ev({
      eventId: "inline-1",
      timeMs: 101,
      isError: true,
      eventType: "error",
      category: "safety",
      parentEventId: "tool-1", // the pairing the run loop records
    });
    const bins = binEvents([toolEvent, inlineAccount], W, 10);
    expect(bins.errors[1], "the pair is ONE incident — the inline account folds into its tool event").toBe(1);
    // Every event still counted exactly once: the dependent lands in its
    // residual category lane (safety), the root on the ridge.
    expect(bins.eventCount).toBe(2);
    expect(bins.totals[1]).toBe(2);
    expect(bins.counts[1]![SWEEP_CATEGORY_IDS.indexOf("safety")]).toBe(1);
    assertBinsHonest(bins, [toolEvent, inlineAccount]);
  });

  test("…plus a safety finding = TWO — every finding is its own incident", () => {
    const toolEvent = ev({ eventId: "tool-1", timeMs: 100, isError: true, parentEventId: null });
    const inlineAccount = ev({
      eventId: "inline-1", timeMs: 101, isError: true, parentEventId: "tool-1", category: "safety",
    });
    const finding = ev({
      eventId: "quality-1", timeMs: 300, isError: true, eventType: "quality", category: "safety",
      parentEventId: null, // end-of-run findings are parented to the run, not to an error
    });
    const bins = binEvents([toolEvent, inlineAccount, finding], W, 10);
    expect(bins.errors.reduce((a, b) => a + b, 0), "one gate-block + one finding = two incidents").toBe(2);
    expect(bins.eventCount).toBe(3);
    assertBinsHonest(bins, [toolEvent, inlineAccount, finding]);
  });

  test("an error whose parent is NOT an error is its own incident (a provider error under its run)", () => {
    const runEvent = ev({ eventId: "run-1", timeMs: 50, isError: false, eventType: "run" });
    const providerError = ev({
      eventId: "err-1", timeMs: 100, isError: true, parentEventId: "run-1",
    });
    const bins = binEvents([runEvent, providerError], W, 10);
    expect(bins.errors[1], "the parent did not fail — nothing to fold into").toBe(1);
    expect(bins.eventCount).toBe(2);
  });

  test("the pairing is deny-by-default: a parent the list does not carry does NOT fold", () => {
    // Old ledger rows recorded before the pairing existed — or a parent
    // outside the feed. The event is its own incident; a guessed fold on
    // proximity or shape would be a fabricated correlation.
    const orphan = ev({
      eventId: "inline-old", timeMs: 100, isError: true, parentEventId: "tool-gone",
    });
    const bins = binEvents([orphan], W, 10);
    expect(bins.errors[1]).toBe(1);
    expect(bins.eventCount).toBe(1);
  });

  test("the fold is transitive through a chain of dependents — the ROOT counts, once", () => {
    const root = ev({ eventId: "tool-1", timeMs: 100, isError: true, parentEventId: null });
    const dependent = ev({ eventId: "inline-1", timeMs: 101, isError: true, parentEventId: "tool-1" });
    const secondOrder = ev({ eventId: "inline-2", timeMs: 102, isError: true, parentEventId: "inline-1" });
    const bins = binEvents([root, dependent, secondOrder], W, 10);
    expect(bins.errors.reduce((a, b) => a + b, 0), "three events, one incident").toBe(1);
    expect(bins.eventCount).toBe(3);
  });

  test("an incident is anchored at its ROOT's bin — a window edge cannot split it", () => {
    const toolEvent = ev({ eventId: "tool-1", timeMs: 50, isError: true, parentEventId: null });
    const inlineAccount = ev({
      eventId: "inline-1", timeMs: 150, isError: true, parentEventId: "tool-1", category: "safety",
    });
    // A window that contains only the DEPENDENT: the incident began outside
    // it, so the window shows zero ridge and one ordinary safety event.
    const half: SweepWindow = { t0: 101, t1: 200 };
    const bins = binEvents([toolEvent, inlineAccount], half, 10);
    expect(bins.errors.reduce((a, b) => a + b, 0)).toBe(0);
    expect(bins.eventCount).toBe(1);
    const safety = SWEEP_CATEGORY_IDS.indexOf("safety");
    expect(bins.counts.reduce((a, row) => a + row[safety]!, 0)).toBe(1);
  });

  // ── THE FALLBACK'S RIDGE AGREES WITH THE SPECTRUM'S ERROR ROW ──────────
  //
  // The engine spectrum (the band's preferred source and the counting-policy
  // owner) counts a failure as `outcome === "failed" || error_code !== null`
  // over the raw ledger columns. The client fallback bins the same rows
  // itself, so the two paths must agree row for row — the divergence this
  // arm pins is the OLD-DATA shape: a gate-block's inline `error` account
  // recorded BEFORE the parent-pairing landed (outcome denied, no error
  // code, NO parent), which the old fallback counted as its own incident
  // while the spectrum never counted it.

  test("an unparented denied inline account: the fallback's ridge and the spectrum's error row count it the same way", () => {
    // createTempDir registers its own removal (creation + cleanup fused in
    // the owner — no hand-written hook that can drift out of scope).
    const dir = createTempDir("sweep-bins-agreement-");
    const LEDGER = "ledger-agreement";
    const minute = (m: number) => new Date(Date.UTC(2026, 6, 1, 0, m, 0, 0)).toISOString();
    const store = createTimelineStore({ path: join(dir, "t.db"), ledgerId: LEDGER });
    // The pre-pairing gate-block: the tool event (failed) plus its inline
    // account with NO parent_event_id — the exact old-data divergence shape.
    store.appendEvent({
      eventId: "ag-tool-1", ledgerId: LEDGER, eventType: "tool",
      actor: { kind: "user", id: "u-1" }, description: "tool:write_file",
      wallTime: minute(1), correlation: { runId: "run-a" }, outcome: "failed",
      error: { category: "tool", code: "tool_failed", message: "blocked", retryable: false },
    });
    store.appendEvent({
      eventId: "ag-inline-old", ledgerId: LEDGER, eventType: "error",
      actor: { kind: "harness", id: "sink" }, description: "the call was blocked",
      wallTime: minute(2), correlation: { runId: "run-a" }, outcome: "denied",
    });
    // The post-pairing gate-block: the same pair WITH the recorded parent link.
    store.appendEvent({
      eventId: "ag-tool-2", ledgerId: LEDGER, eventType: "tool",
      actor: { kind: "user", id: "u-1" }, description: "tool:read_file",
      wallTime: minute(10), correlation: { runId: "run-a" }, outcome: "failed",
      error: { category: "tool", code: "tool_failed", message: "blocked", retryable: false },
    });
    store.appendEvent({
      eventId: "ag-inline-new", ledgerId: LEDGER, eventType: "error",
      actor: { kind: "harness", id: "sink" }, description: "the call was blocked",
      wallTime: minute(11), correlation: { runId: "run-a" }, outcome: "denied",
      parentEventId: "ag-tool-2",
    });
    // A failed finding — its own incident on both paths.
    store.appendEvent({
      eventId: "ag-finding", ledgerId: LEDGER, eventType: "quality",
      actor: { kind: "harness", id: "sink" }, description: "safety finding",
      wallTime: minute(20), correlation: { runId: "run-a" }, outcome: "failed",
      error: { category: "safety", code: "safety_finding", message: "detected", retryable: false },
    });

    // Path 1 — the served spectrum's error row.
    const spectrum = store.spectrum({ bins: 10 });
    const spectrumErrors = spectrum.errorBins.reduce((a, b) => a + b, 0);

    // Path 2 — the client fallback over the SAME rows (the summary
    // projection the streamed window carries, projected + folded).
    const events = store.querySummaries()
      .map((r) => toSweepEvent({
        eventId: r.eventId, eventType: r.eventType, wallTime: r.wallTime,
        outcome: r.outcome, errorCode: r.errorCode, runId: r.runId,
        parentEventId: r.parentEventId,
      }))
      .filter((e): e is SweepEvent => e !== null);
    const window = eventCoverage(events)!;
    const bins = binEvents(events, window, 10);
    const fallbackErrors = bins.errors.reduce((a, b) => a + b, 0);

    expect(spectrumErrors, "the spectrum counts the two failed tools + the finding = 3; denied accounts never").toBe(3);
    expect(fallbackErrors, "the fallback's ridge agrees with the spectrum on the same ledger rows").toBe(spectrumErrors);
    // The unparented denied account specifically: not an incident on
    // EITHER path — it lands in the fallback's residual safety lane.
    expect(events.find((e) => e.eventId === "ag-inline-old")!.isError).toBe(false);
    const safety = SWEEP_CATEGORY_IDS.indexOf("safety");
    expect(bins.counts.reduce((a, row) => a + row[safety]!, 0)).toBe(2);
    expect(bins.eventCount).toBe(5);
    assertBinsHonest(bins, events);
    store.close();
  });

  test("categories land in their own stack index", () => {
    const events = [
      ev({ timeMs: 10, category: "llm" }),
      ev({ timeMs: 10, category: "effect" }),
    ];
    const bins = binEvents(events, W, 1);
    expect(bins.counts[0]![SWEEP_CATEGORY_IDS.indexOf("llm")]).toBe(1);
    expect(bins.counts[0]![SWEEP_CATEGORY_IDS.indexOf("effect")]).toBe(1);
    expect(bins.counts[0]![SWEEP_CATEGORY_IDS.indexOf("tool")]).toBe(0);
  });

  test("rejects degenerate windows and bin counts", () => {
    expect(() => binEvents([], { t0: 5, t1: 5 }, 10)).toThrow(SweepHonestyViolation);
    expect(() => binEvents([], W, 0)).toThrow(SweepHonestyViolation);
    expect(() => binEvents([], W, 1.5)).toThrow(SweepHonestyViolation);
  });
});

describe("binIndexFor", () => {
  test("maps interior, edge and out-of-window times", () => {
    expect(binIndexFor(0, W, 10)).toBe(0);
    expect(binIndexFor(999, W, 10)).toBe(9);
    expect(binIndexFor(1000, W, 10)).toBe(9); // right edge clamps
    expect(binIndexFor(1001, W, 10)).toBeNull();
    expect(binIndexFor(-1, W, 10)).toBeNull();
  });
});

describe("honesty guards — MUTATION TESTS (fabricated bin → fail)", () => {
  const events = [ev({ timeMs: 100 }), ev({ timeMs: 600, isError: true })];

  test("clean bins pass both guards", () => {
    const bins = binEvents(events, W, 10);
    expect(() => assertBinsConsistent(bins)).not.toThrow();
    expect(() => assertBinsHonest(bins, events)).not.toThrow();
  });

  test("a fabricated category count fails assertBinsHonest", () => {
    const bins = binEvents(events, W, 10);
    const mutated = {
      ...bins,
      counts: bins.counts.map((row, i) =>
        i === 3 ? row.map((c, j) => (j === 0 ? c + 2 : c)) : row,
      ),
      // Keep totals consistent so ONLY the source-of-truth check can catch
      // it — the strongest mutation.
      totals: bins.totals.map((t, i) => (i === 3 ? t + 2 : t)),
      eventCount: bins.eventCount + 2,
    };
    expect(() => assertBinsHonest(mutated, events)).toThrow(SweepHonestyViolation);
  });

  test("a fabricated error-ridge count fails assertBinsHonest", () => {
    const bins = binEvents(events, W, 10);
    const mutated = {
      ...bins,
      errors: bins.errors.map((e, i) => (i === 0 ? e + 1 : e)),
      totals: bins.totals.map((t, i) => (i === 0 ? t + 1 : t)),
      eventCount: bins.eventCount + 1,
    };
    expect(() => assertBinsHonest(mutated, events)).toThrow(SweepHonestyViolation);
  });

  test("totals that disagree with the stack fail assertBinsConsistent", () => {
    const bins = binEvents(events, W, 10);
    const mutated = {
      ...bins,
      totals: bins.totals.map((t, i) => (i === 1 ? t + 5 : t)),
    };
    expect(() => assertBinsConsistent(mutated)).toThrow(SweepHonestyViolation);
  });

  test("an eventCount claim unsupported by the cells fails", () => {
    const bins = binEvents(events, W, 10);
    const mutated = { ...bins, eventCount: bins.eventCount + 7 };
    expect(() => assertBinsConsistent(mutated)).toThrow(SweepHonestyViolation);
  });

  test("negative counts fail", () => {
    const bins = binEvents(events, W, 10);
    const mutated = {
      ...bins,
      errors: bins.errors.map((e, i) => (i === 2 ? -1 : e)),
    };
    expect(() => assertBinsConsistent(mutated)).toThrow(SweepHonestyViolation);
  });
});

describe("eventCoverage — the honest window label", () => {
  test("null when nothing is loaded (absence renders as absence)", () => {
    expect(eventCoverage([])).toBeNull();
  });

  test("spans exactly the recorded events", () => {
    const c = eventCoverage([ev({ timeMs: 300 }), ev({ timeMs: 900 })]);
    expect(c).toEqual({ t0: 300, t1: 900 });
  });

  test("a single event covers a minimal 1ms window, not invented history", () => {
    const c = eventCoverage([ev({ timeMs: 500 })]);
    expect(c).toEqual({ t0: 500, t1: 501 });
  });
});
