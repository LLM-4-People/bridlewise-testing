// @vitest-environment node
/**
 * Now-edge honesty (§6.2/§6.6) — MUTATION-TESTED:
 *   - the edge ticking without a received event → fail;
 *   - a frozen (non-live) band rendered as live → fail;
 *   - a non-live band without its status line → fail.
 */
import { describe, expect, test } from "vitest";

import {
  INITIAL_NOW_EDGE,
  advanceNowEdge,
  assertHonestBandRender,
  bandStatusLine,
  bandStatusTone,
  formatClock,
  formatFullPrecision,
} from "../../src/cockpit/sweep/now-edge";
import {
  SweepHonestyViolation,
  type StreamState,
  type SweepEvent,
} from "../../src/cockpit/sweep/types";

const ev = (timeMs: number): SweepEvent => ({
  eventId: `e${timeMs}`,
  timeMs,
  category: "tool",
  isError: false,
  eventType: "tool",
  outcome: null,
  errorCode: null,
  runId: "r",
  turnId: null,
  parentEventId: null,
  description: "",
});

const stream = (
  status: StreamState["status"],
  lastEventMs: number | null = null,
): StreamState => ({ status, lastEventMs, eventsReceived: lastEventMs === null ? 0 : 1 });

describe("advanceNowEdge — the ONLY mover", () => {
  test("advances exactly on a received event", () => {
    const s1 = advanceNowEdge(INITIAL_NOW_EDGE, ev(1000));
    expect(s1.timeMs).toBe(1000);
    expect(s1.ticks).toBe(1);
    const s2 = advanceNowEdge(s1, ev(2000));
    expect(s2.timeMs).toBe(2000);
    expect(s2.ticks).toBe(2);
  });

  test("an out-of-order historical event ticks but never pulls now backwards", () => {
    const s1 = advanceNowEdge(INITIAL_NOW_EDGE, ev(5000));
    const s2 = advanceNowEdge(s1, ev(1000));
    expect(s2.timeMs).toBe(5000);
    expect(s2.ticks).toBe(2);
  });

  test("the module exposes no timer/no-event way to advance (API shape)", async () => {
    const mod = await import("../../src/cockpit/sweep/now-edge");
    // Every exported function that returns a NowEdgeState requires an event.
    expect(advanceNowEdge.length).toBe(2);
    expect("tickNowEdge" in mod).toBe(false);
    expect("advanceToWallClock" in mod).toBe(false);
  });
});

describe("bandStatusLine — the spec wording, on the band", () => {
  test("live → null (the band may render live)", () => {
    expect(bandStatusLine(stream("live", 1))).toBeNull();
  });

  test("reconnecting carries the last-event clock (spec sentence)", () => {
    const t = Date.parse("2026-07-25T14:02:31");
    expect(bandStatusLine(stream("reconnecting", t))).toBe(
      `stream reconnecting — last event ${formatClock(t)}`,
    );
    expect(formatClock(t)).toBe("14:02:31");
  });

  test("reconnecting with nothing received says so — no invented clock", () => {
    expect(bandStatusLine(stream("reconnecting"))).toBe(
      "stream reconnecting — no events received yet",
    );
  });

  test("idle and closed are visibly not-live", () => {
    expect(bandStatusLine(stream("idle"))).toBe("not live — no stream open");
    expect(bandStatusLine(stream("closed", 1000))).toMatch(/^stream closed — last event /);
  });

  test("ending states the inference's own word with the last-event clock (UIE-084)", () => {
    const t = Date.parse("2026-07-25T14:02:31");
    expect(bandStatusLine(stream("ending", t))).toBe(
      `stream ending — last event ${formatClock(t)}`,
    );
    expect(bandStatusLine(stream("ending"))).toBe(
      "stream ending — no events received yet",
    );
  });
});

describe("assertHonestBandRender — MUTATION TESTS", () => {
  const edge = advanceNowEdge(INITIAL_NOW_EDGE, ev(1000));

  test("an honest live render passes", () => {
    expect(() =>
      assertHonestBandRender(stream("live", 1000), edge, {
        liveEdgeShown: true,
        statusLineShown: null,
        edgeTimeMs: 1000,
      }),
    ).not.toThrow();
  });

  test("an honest reconnecting render passes", () => {
    const s = stream("reconnecting", 1000);
    expect(() =>
      assertHonestBandRender(s, edge, {
        liveEdgeShown: false,
        statusLineShown: bandStatusLine(s),
        edgeTimeMs: 1000,
      }),
    ).not.toThrow();
  });

  test("MUTATION: live treatment on a reconnecting stream → violation", () => {
    const s = stream("reconnecting", 1000);
    expect(() =>
      assertHonestBandRender(s, edge, {
        liveEdgeShown: true, // the frozen-fake-live mutation
        statusLineShown: bandStatusLine(s),
        edgeTimeMs: 1000,
      }),
    ).toThrow(SweepHonestyViolation);
  });

  test("MUTATION: non-live band with NO status line → violation", () => {
    const s = stream("reconnecting", 1000);
    expect(() =>
      assertHonestBandRender(s, edge, {
        liveEdgeShown: false,
        statusLineShown: null, // hiding the reconnect state
        edgeTimeMs: 1000,
      }),
    ).toThrow(SweepHonestyViolation);
  });

  test("MUTATION: an edge with no received event → violation", () => {
    expect(() =>
      assertHonestBandRender(stream("live", null), INITIAL_NOW_EDGE, {
        liveEdgeShown: false,
        statusLineShown: null,
        edgeTimeMs: 1000, // ticking without an event
      }),
    ).toThrow(SweepHonestyViolation);
  });

  test("MUTATION: an edge ahead of the last received event → violation", () => {
    expect(() =>
      assertHonestBandRender(stream("live", 1000), edge, {
        liveEdgeShown: true,
        statusLineShown: null,
        edgeTimeMs: 2000, // wall-clock creep — no event reached 2000
      }),
    ).toThrow(SweepHonestyViolation);
  });
});

describe("bandStatusTone — the dark-cockpit law (§1.3): color = actionable abnormality only", () => {
  test("no conversation open: every at-rest state is QUIET — no stream is normal", () => {
    expect(bandStatusTone(stream("idle"), false)).toBe("quiet");
    expect(bandStatusTone(stream("closed", 1000), false)).toBe("quiet");
    expect(bandStatusTone(stream("reconnecting", 1000), false)).toBe("quiet");
  });

  test("conversation open + stream dead: the chip ALERTS — a stream should exist", () => {
    expect(bandStatusTone(stream("idle"), true)).toBe("alert");
    expect(bandStatusTone(stream("closed", 1000), true)).toBe("alert");
    expect(bandStatusTone(stream("reconnecting", 1000), true)).toBe("alert");
  });

  test("live is quiet either way (no chip renders when live)", () => {
    expect(bandStatusTone(stream("live", 1000), true)).toBe("quiet");
    expect(bandStatusTone(stream("live", 1000), false)).toBe("quiet");
  });

  test("ending is quiet either way — a run finishing is not an abnormality (UIE-084)", () => {
    // The stream still exists (the socket has not closed; the epilogue may
    // still deliver), so the §1.3 law spends no alert on it.
    expect(bandStatusTone(stream("ending", 1000), true)).toBe("quiet");
    expect(bandStatusTone(stream("ending", 1000), false)).toBe("quiet");
  });

  test("MUTATION: the tone depends on conversationOpen — a constant mapping would fail one side", () => {
    const s = stream("idle");
    expect(bandStatusTone(s, false)).not.toBe(bandStatusTone(s, true));
  });
});

describe("clock formatting", () => {
  test("full precision carries milliseconds", () => {
    const t = Date.parse("2026-07-25T14:02:31.007");
    expect(formatFullPrecision(t)).toBe("14:02:31.007");
  });
});
