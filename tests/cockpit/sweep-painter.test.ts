// @vitest-environment node
/**
 * Painter honesty against a recording mock context:
 *   - gaps paint NOTHING (no bar where no events are);
 *   - the error ridge paints in --alarm on top;
 *   - a dishonest frame (live edge while reconnecting) THROWS in the paint
 *     path itself — not only in tests;
 *   - the non-live veil paints whenever the stream is not live.
 */
import { describe, expect, test } from "vitest";

import { binEvents } from "../../src/cockpit/sweep/bins";
import { resolveSweepPalette } from "../../src/cockpit/sweep/categories";
import { buildCausalBands } from "../../src/cockpit/sweep/causal";
import { INITIAL_NOW_EDGE, advanceNowEdge } from "../../src/cockpit/sweep/now-edge";
import {
  paintSweep,
  type CanvasLike,
  type SweepFrame,
} from "../../src/cockpit/sweep/painter";
import {
  SweepHonestyViolation,
  type StreamState,
  type SweepEvent,
} from "../../src/cockpit/sweep/types";

type Rect = { x: number; y: number; w: number; h: number; fill: string; alpha: number };

function recordingCtx(): CanvasLike & { rects: Rect[] } {
  const rects: Rect[] = [];
  const ctx = {
    rects,
    fillStyle: "" as string,
    strokeStyle: "" as string,
    globalAlpha: 1,
    lineWidth: 1,
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, fill: String(this.fillStyle), alpha: this.globalAlpha });
    },
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
  };
  return ctx;
}

const palette = resolveSweepPalette(() => "");

const ev = (timeMs: number, extra: Partial<SweepEvent> = {}): SweepEvent => ({
  eventId: extra.eventId ?? `e${timeMs}-${Math.random()}`,
  timeMs,
  category: extra.category ?? "tool",
  isError: extra.isError ?? false,
  eventType: extra.eventType ?? "tool",
  outcome: null,
  errorCode: null,
  runId: extra.runId ?? "r",
  turnId: extra.turnId ?? "t",
  parentEventId: null,
  description: "",
});

const live = (lastEventMs: number): StreamState => ({
  status: "live",
  lastEventMs,
  eventsReceived: 1,
});

function frameFor(
  events: SweepEvent[],
  overrides: Partial<SweepFrame> = {},
): SweepFrame {
  const view = { t0: 0, t1: 1000 };
  const edge = events.reduce((s, e) => advanceNowEdge(s, e), INITIAL_NOW_EDGE);
  return {
    widthPx: 1000,
    heightPx: 48,
    view,
    level: "runs",
    bins: binEvents(events, view, 10),
    causal: null,
    palette,
    stream: events.length > 0 ? live(edge.timeMs!) : { status: "idle", lastEventMs: null, eventsReceived: 0 },
    nowEdge: edge,
    headMs: null,
    hoverMs: null,
    marks: [],
    reducedMotion: false,
    ...overrides,
  };
}

describe("gaps render as gaps", () => {
  test("no bar is painted over the empty middle of the window", () => {
    const ctx = recordingCtx();
    // events only in bin 0 and bin 9 — bins 1..8 are a real recorded gap
    paintSweep(ctx, frameFor([ev(50), ev(950)]));
    const catColor = palette.categories.tool;
    const bars = ctx.rects.filter((r) => r.fill === catColor);
    expect(bars).toHaveLength(2);
    // Nothing painted in the gap region x∈[100, 900) except ground/edge.
    const gapBars = bars.filter((r) => r.x >= 100 && r.x < 900);
    expect(gapBars).toHaveLength(0);
  });

  test("an empty view paints only ground (and the honest veil when idle)", () => {
    const ctx = recordingCtx();
    paintSweep(ctx, frameFor([]));
    const nonGround = ctx.rects.filter((r) => r.fill !== palette.ground1);
    expect(nonGround).toHaveLength(0);
  });
});

describe("the error ridge", () => {
  test("errors paint in alarm, on top of the stack", () => {
    const ctx = recordingCtx();
    paintSweep(ctx, frameFor([ev(150), ev(150, { isError: true })]));
    const alarmRects = ctx.rects.filter((r) => r.fill === palette.alarm);
    expect(alarmRects).toHaveLength(1);
    const toolRect = ctx.rects.find((r) => r.fill === palette.categories.tool)!;
    // ridge sits above (smaller y) the category stack
    expect(alarmRects[0]!.y).toBeLessThan(toolRect.y);
  });
});

describe("the now edge", () => {
  test("paints in beam at the last event's x when live", () => {
    const ctx = recordingCtx();
    paintSweep(ctx, frameFor([ev(500)]));
    const beamRects = ctx.rects.filter((r) => r.fill === palette.beam);
    expect(beamRects).toHaveLength(1);
    expect(beamRects[0]!.x).toBeCloseTo(500, 0);
  });

  test("MUTATION: a frame whose edge is ahead of the last received event THROWS", () => {
    const ctx = recordingCtx();
    const f = frameFor([ev(500)], {
      // The stream's own record says the last event was at 500; a frame
      // claiming an edge at 900 fabricated a tick without an event.
      nowEdge: { timeMs: 900, ticks: 2 },
    });
    expect(() => paintSweep(ctx, f)).toThrow(SweepHonestyViolation);
  });

  test("MUTATION: a frame with an edge but a stream that received nothing THROWS", () => {
    const ctx = recordingCtx();
    const f = frameFor([], {
      stream: { status: "idle", lastEventMs: null, eventsReceived: 0 },
      nowEdge: { timeMs: 500, ticks: 1 }, // fabricated edge
    });
    expect(() => paintSweep(ctx, f)).toThrow(SweepHonestyViolation);
  });

  test("a reconnecting frame with its status line paints the veil, no beam edge", () => {
    const ctx = recordingCtx();
    // The COMPONENT renders the status line in DOM; the painter's claim
    // carries it — an honest reconnecting frame paints veil, never beam.
    const events = [ev(500)];
    const edge = advanceNowEdge(INITIAL_NOW_EDGE, events[0]!);
    const f = frameFor(events, {
      stream: { status: "reconnecting", lastEventMs: 500, eventsReceived: 1 },
      nowEdge: edge,
    });
    // paintSweep computes the claim itself from the stream — honest path:
    expect(() => paintSweep(ctx, f)).not.toThrow();
    expect(ctx.rects.some((r) => r.fill === palette.beam)).toBe(false);
    // the veil: a translucent full-band rect painted last
    const veil = ctx.rects[ctx.rects.length - 1]!;
    expect(veil.alpha).toBeLessThan(1);
    expect(veil.w).toBe(1000);
  });
});

describe("causal levels paint real ticks only", () => {
  test("every tick rect corresponds to a real event", () => {
    const events = [
      ev(100, { eventType: "run", turnId: null, category: "lifecycle" }),
      ev(200, { eventType: "turn", category: "llm" }),
      ev(300),
      ev(400, { isError: true }),
    ];
    const ctx = recordingCtx();
    paintSweep(ctx, frameFor(events, {
      level: "causal",
      causal: buildCausalBands(events),
    }));
    const tickFills = new Set([
      palette.categories.lifecycle,
      palette.categories.llm,
      palette.categories.tool,
      palette.alarm,
    ]);
    const ticks = ctx.rects.filter((r) => tickFills.has(r.fill) && r.w <= 2);
    expect(ticks.length).toBe(events.length);
  });
});

describe("head + hover + marks", () => {
  test("planted head paints in beam; hover in ink; marks with stems", () => {
    const ctx = recordingCtx();
    paintSweep(ctx, frameFor([ev(500)], {
      headMs: 250,
      hoverMs: 750,
      marks: [{ id: "m1", timeMs: 600, label: "mark", createdAtMs: 0, origin: "user", storage: "local" }],
    }));
    expect(ctx.rects.filter((r) => r.fill === palette.beam).length).toBe(2); // edge + head
    expect(ctx.rects.some((r) => r.fill === palette.ink3 && Math.round(r.x) === 750)).toBe(true);
    expect(ctx.rects.filter((r) => r.fill === palette.ink2).length).toBe(2); // stem + flag head
  });
});
