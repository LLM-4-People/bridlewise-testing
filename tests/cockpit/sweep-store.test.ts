// @vitest-environment node
/**
 * The sweep store seam: head plant/scrub/live semantics (`headChange`
 * consumers read `sweepHead`), the now edge moving ONLY through
 * `recordReceivedEvent`, marks at the honest "now", and ARM single-shot
 * firing. Node env (no localStorage) — persistence degrades to
 * session-only without crashing, which is itself asserted by these tests
 * running at all.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  armedTriggers,
  armTrigger,
  clearArm,
  cockedTriggerCount,
  dropMarkAtNow,
  fireMatchingArms,
  nowEdge,
  plantHead,
  reArmTrigger,
  recordReceivedEvent,
  resetSweep,
  returnToLive,
  scrubHead,
  streamState,
  sweepHead,
  sweepMarks,
  setStreamStatus,
} from "../../src/cockpit/sweep/sweep-store";
import { evalArmPredicate, evalContextCross, marksStorageDegraded } from "../../src/cockpit/sweep/marks";
import type { SweepEvent } from "../../src/cockpit/sweep/types";

const ev = (timeMs: number, extra: Partial<SweepEvent> = {}): SweepEvent => ({
  eventId: extra.eventId ?? `e${timeMs}`,
  timeMs,
  category: extra.category ?? "tool",
  isError: extra.isError ?? false,
  eventType: extra.eventType ?? "tool",
  outcome: extra.outcome ?? null,
  errorCode: extra.errorCode ?? null,
  runId: "r",
  turnId: "t",
  parentEventId: null,
  description: extra.description ?? "",
});

beforeEach(() => {
  resetSweep();
  sweepMarks.set([]);
  armedTriggers.set([]);
});

describe("head — the asOf seam", () => {
  test("plant / return-to-live round-trip", () => {
    expect(sweepHead.get()).toBeNull();
    plantHead(12345);
    expect(sweepHead.get()).toBe(12345);
    returnToLive();
    expect(sweepHead.get()).toBeNull();
  });

  test("scrub with nothing received is a no-op — no invented now", () => {
    expect(scrubHead(-1000)).toBeNull();
    expect(sweepHead.get()).toBeNull();
  });

  test("scrub back starts from the now edge (the last real event)", () => {
    recordReceivedEvent(ev(10_000));
    expect(scrubHead(-1000)).toBe(9_000);
    expect(sweepHead.get()).toBe(9_000);
  });

  test("scrubbing forward to/past the edge returns to live", () => {
    recordReceivedEvent(ev(10_000));
    plantHead(9_500);
    expect(scrubHead(1000)).toBeNull();
    expect(sweepHead.get()).toBeNull();
  });
});

describe("now edge + stream state", () => {
  test("the edge moves only on recordReceivedEvent", () => {
    expect(nowEdge.get().timeMs).toBeNull();
    setStreamStatus("reconnecting");
    expect(nowEdge.get().timeMs).toBeNull(); // status change ≠ tick
    recordReceivedEvent(ev(5000));
    expect(nowEdge.get().timeMs).toBe(5000);
    expect(nowEdge.get().ticks).toBe(1);
  });

  test("receiving an event is proof of liveness", () => {
    setStreamStatus("reconnecting");
    recordReceivedEvent(ev(5000));
    expect(streamState.get().status).toBe("live");
    expect(streamState.get().lastEventMs).toBe(5000);
    expect(streamState.get().eventsReceived).toBe(1);
  });
});

describe("marks — at the honest now", () => {
  test("no events received → no mark (nothing recorded yet)", () => {
    expect(dropMarkAtNow()).toBeNull();
    expect(sweepMarks.get()).toHaveLength(0);
  });

  test("drops at the last event's time, labeled local", () => {
    recordReceivedEvent(ev(7777));
    const m = dropMarkAtNow("my mark");
    expect(m).not.toBeNull();
    expect(m!.timeMs).toBe(7777);
    expect(m!.storage).toBe("local");
    expect(m!.origin).toBe("user");
    expect(sweepMarks.get()).toHaveLength(1);
  });
});

describe("ARM — single-shot retro-trigger (client v1)", () => {
  test("tool-errors fires once on a failing tool event, at the EVENT time", () => {
    armTrigger("tool-errors");
    const dropped = fireMatchingArms(ev(4000, { isError: true }));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.timeMs).toBe(4000);
    expect(dropped[0]!.origin).toBe("arm");
    expect(armedTriggers.get()[0]!.firedAtMs).toBe(4000);
    // single-shot: a second match does not fire again
    expect(fireMatchingArms(ev(5000, { isError: true }))).toHaveLength(0);
  });

  test("recordReceivedEvent evaluates cocked triggers", () => {
    armTrigger("check-fails");
    recordReceivedEvent(ev(9000, { eventType: "test", isError: true, category: "effect" }));
    expect(sweepMarks.get().some((m) => m.origin === "arm")).toBe(true);
  });

  test("file-edited matches on the recorded description path", () => {
    const t = armTrigger("file-edited", "reader.ts");
    expect(
      evalArmPredicate(t, ev(1, { eventType: "file-effect", description: "edited src/lib/data/reader.ts" })),
    ).toBe(true);
    expect(
      evalArmPredicate(t, ev(1, { eventType: "file-effect", description: "edited other.ts" })),
    ).toBe(false);
  });

  test("context-crosses is NOT event-evaluable (honest v1 limit) but is signal-evaluable", () => {
    const t = armTrigger("context-crosses", "80");
    expect(evalArmPredicate(t, ev(1))).toBe(false);
    expect(evalContextCross(t, 79)).toBe(false);
    expect(evalContextCross(t, 80)).toBe(true);
  });

  test("clearArm removes the trigger", () => {
    const t = armTrigger("tool-errors");
    clearArm(t.id);
    expect(armedTriggers.get()).toHaveLength(0);
  });

  test("RE-ARM re-cocks a fired row (a new arming of the same predicate); a cocked row is a no-op", () => {
    const t = armTrigger("tool-errors");
    fireMatchingArms(ev(4000, { isError: true }));
    expect(armedTriggers.get()[0]!.firedAtMs).toBe(4000);
    const reArmed = reArmTrigger(t.id);
    expect(reArmed).not.toBeNull();
    expect(reArmed!.firedAtMs).toBeNull();
    expect(reArmed!.id).toBe(t.id);
    // Already waiting: re-arming again changes nothing.
    expect(reArmTrigger(t.id)).toBeNull();
  });

  test("the COCKED COUNT is the standing derivation (armed-and-waiting only)", () => {
    expect(cockedTriggerCount.get()).toBe(0);
    armTrigger("tool-errors");
    armTrigger("check-fails");
    expect(cockedTriggerCount.get()).toBe(2);
    // A firing moves the count down — the row fired, it is not waiting.
    fireMatchingArms(ev(4000, { isError: true }));
    expect(cockedTriggerCount.get()).toBe(1);
    // Re-arm restores it.
    reArmTrigger(armedTriggers.get().find((t) => t.firedAtMs !== null)!.id);
    expect(cockedTriggerCount.get()).toBe(2);
  });

  test("RE-ARM stamps a strictly newer generation, even inside one clock millisecond", () => {
    // The generation is the merge seams' recency discriminator — it must
    // never tie with the row's own prior generation, or a stale firing of
    // the OLD generation could un-fire the re-cock through the within-
    // generation monotone rule. Freeze the clock so the tie is CERTAIN:
    // arm and re-arm read the same millisecond.
    const realNow = Date.now;
    const frozenMs = 1_700_000_000_000;
    try {
      vi.spyOn(Date, "now").mockReturnValue(frozenMs);
      const t = armTrigger("tool-errors");
      fireMatchingArms(ev(4000, { isError: true }));
      const reArmed = reArmTrigger(t.id);
      expect(reArmed).not.toBeNull();
      expect(reArmed!.armedAtMs).toBeGreaterThan(t.armedAtMs);
      // Each generation chains: strictly newer than the last, still under
      // the frozen clock.
      fireMatchingArms(ev(5000, { isError: true }));
      const again = reArmTrigger(t.id);
      expect(again!.armedAtMs).toBeGreaterThan(reArmed!.armedAtMs);
    } finally {
      vi.restoreAllMocks();
      void realNow;
    }
  });
});

describe("the degraded write seam — no browser storage (this suite's node env)", () => {
  test("writes degrade to session-only, the reason is readable, and every verb still works", () => {
    armTrigger("tool-errors");
    // No storage in this environment: the seam returned this tab's own
    // snapshot unchanged — the row stands, session-only.
    expect(armedTriggers.get()).toHaveLength(1);
    expect(marksStorageDegraded()).toBe("browser storage unavailable");
    // The firing path works session-only.
    const dropped = fireMatchingArms(ev(4000, { isError: true }));
    expect(dropped).toHaveLength(1);
    expect(armedTriggers.get()[0]!.firedAtMs).toBe(4000);
    // A clear works session-only too (its tombstone guards adoption only).
    clearArm(armedTriggers.get()[0]!.id);
    expect(armedTriggers.get()).toHaveLength(0);
  });
});
