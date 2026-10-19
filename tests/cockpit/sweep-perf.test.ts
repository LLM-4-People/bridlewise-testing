// @vitest-environment node
/**
 * SWEEP latency budgets (§1.5 F2, task spec): with 30k synthetic events —
 *   - full client binning < 100ms (the zoom rebin budget);
 *   - a zoomed sub-window rebin < 100ms;
 *   - causal band build over a zoomed window < 100ms;
 *   - a full paint pass over pre-built bins < 16ms (head interaction is a
 *     repaint of existing bins — the <16ms budget).
 * Budgets are generous CI ceilings (local runs are ~10× faster); a
 * regression that blows 100ms is an algorithmic bug, not jitter.
 */
import { describe, expect, test } from "vitest";

import { binEvents } from "../../src/cockpit/sweep/bins";
import { clientWindowSource } from "../../src/cockpit/sweep/bin-source";
import { resolveSweepPalette } from "../../src/cockpit/sweep/categories";
import { buildCausalBands } from "../../src/cockpit/sweep/causal";
import {
  assertNavigationCoalesced,
  eventAtOrBefore,
  frameCoalesced,
} from "../../src/cockpit/sweep/focus-seam";
import { INITIAL_NOW_EDGE, advanceNowEdge } from "../../src/cockpit/sweep/now-edge";
import { paintSweep, type CanvasLike } from "../../src/cockpit/sweep/painter";
import { zoomWindow } from "../../src/cockpit/sweep/zoom";
import type { SweepEvent } from "../../src/cockpit/sweep/types";

const CATS = ["lifecycle", "user", "llm", "tool", "context", "transport", "effect", "safety"] as const;

/** 30k synthetic events over 6h, clustered into bursts with real gaps. */
function synth30k(): SweepEvent[] {
  const t1 = 1_753_000_000_000;
  const t0 = t1 - 6 * 3600_000;
  const out: SweepEvent[] = [];
  for (let i = 0; i < 30_000; i++) {
    const burst = Math.floor(i / 300);
    const timeMs = t0 + burst * 60_000 + (i % 300) * 90;
    out.push({
      eventId: `s${i}`,
      timeMs,
      category: CATS[i % CATS.length]!,
      isError: i % 23 === 0,
      eventType: "tool",
      outcome: null,
      errorCode: null,
      runId: `run-${burst}`,
      turnId: `turn-${Math.floor(i / 30)}`,
      parentEventId: i % 5 === 0 ? null : `s${i - 1}`,
      description: "synthetic",
    });
  }
  return out;
}

const events = synth30k();
const coverage = { t0: events[0]!.timeMs, t1: events[events.length - 1]!.timeMs };

function nullCtx(): CanvasLike {
  return {
    fillStyle: "",
    strokeStyle: "",
    globalAlpha: 1,
    lineWidth: 1,
    fillRect() {},
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
  };
}

describe("30k-event budgets", () => {
  test("full-window client binning (600 bins) < 100ms", () => {
    const t = performance.now();
    const bins = binEvents(events, coverage, 600);
    const took = performance.now() - t;
    expect(bins.eventCount).toBe(30_000);
    expect(took).toBeLessThan(100);
  });

  test("zoom rebin of a sub-window < 100ms", () => {
    const source = clientWindowSource(events);
    const zoomed = zoomWindow(coverage, coverage.t0 + 3600_000, 0.1, coverage);
    const t = performance.now();
    const bins = source.bins(zoomed, 600);
    const took = performance.now() - t;
    expect(bins.window.t1 - bins.window.t0).toBeLessThan(coverage.t1 - coverage.t0);
    expect(took).toBeLessThan(100);
  });

  test("causal band build over a zoomed window < 100ms", () => {
    const source = clientWindowSource(events);
    const zoomed = { t0: coverage.t0, t1: coverage.t0 + 600_000 }; // 10 min
    const t = performance.now();
    const runs = buildCausalBands(source.eventsIn(zoomed));
    const took = performance.now() - t;
    expect(runs.length).toBeGreaterThan(0);
    expect(took).toBeLessThan(100);
  });

  test("a full paint pass over prepared bins < 16ms (head repaint budget)", () => {
    const bins = binEvents(events, coverage, 600);
    const edge = advanceNowEdge(INITIAL_NOW_EDGE, events[events.length - 1]!);
    const frame = {
      widthPx: 1600,
      heightPx: 48,
      view: coverage,
      level: "runs" as const,
      bins,
      causal: null,
      palette: resolveSweepPalette(() => ""),
      stream: { status: "live" as const, lastEventMs: edge.timeMs, eventsReceived: 30_000 },
      nowEdge: edge,
      headMs: coverage.t0 + 1000,
      hoverMs: coverage.t0 + 2000,
      marks: [],
      reducedMotion: false,
    };
    const ctx = nullCtx();
    paintSweep(ctx, frame); // warm
    const t = performance.now();
    paintSweep(ctx, frame);
    const took = performance.now() - t;
    expect(took).toBeLessThan(16);
  });
});

/**
 * THE SCRUB→NAVIGATE LOOP. The band's pointer path does three things per
 * tick: map x→time, stash it, offer it to the frame emitter. Resolution (the
 * binary search that names the event at-or-before the instant) happens ONCE
 * PER EMITTED FRAME, not per tick — which is the whole reason a full-width
 * drag can stay inside a frame budget on a 30k-event window.
 */
describe("the scrub→navigate loop stays inside a frame", () => {
  test("1200 pointer ticks (a full-width drag) cost < 16ms in the emitter path", () => {
    const emitter = frameCoalesced<number>(
      () => {},
      (cb) => {
        void cb;
        return 1;
      },
      () => {},
    );
    const t = performance.now();
    for (let i = 0; i < 1200; i++) emitter.offer(i);
    const took = performance.now() - t;
    expect(took).toBeLessThan(16);
    // …and the 1200 ticks became ONE scheduled frame, not 1200 navigations.
    expect(emitter.stats().offered).toBe(1200);
    expect(emitter.stats().frames).toBe(1);
    assertNavigationCoalesced(emitter.stats());
  });

  test("resolving the event at-or-before an instant over 30k events is O(log n) — 1200 resolutions < 16ms", () => {
    const t = performance.now();
    let hits = 0;
    for (let i = 0; i < 1200; i++) {
      const at = coverage.t0 + ((coverage.t1 - coverage.t0) * i) / 1200;
      if (eventAtOrBefore(events, at) !== null) hits += 1;
    }
    const took = performance.now() - t;
    expect(hits).toBeGreaterThan(1000);
    expect(took).toBeLessThan(16);
  });
});
