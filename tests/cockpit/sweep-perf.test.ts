// @vitest-environment node
/**
 * SWEEP cost budgets (§1.5 F2, task spec): with 30k synthetic events —
 *   - full client binning < 100ms (the zoom rebin budget);
 *   - a zoomed sub-window rebin < 100ms;
 *   - causal band build over a zoomed window < 100ms;
 *   - a full paint pass over pre-built bins < 16ms (head interaction is a
 *     repaint of existing bins — the <16ms budget).
 * Budgets are generous ceilings (local runs are ~10× under them); a
 * regression that blows 100ms is an algorithmic bug, not jitter.
 *
 * EVERY BUDGET IS CPU WORK, NEVER WALL TIME (NO-LOAD-BLOCK). These budgets
 * were wall time, and required Shard 3 went red under host load at 144 ms
 * against 100 and 27 ms against 16: the code waited for a core, it did not do
 * more. `cpuWorkOf` (engine/src/shared/run-cpu.ts) counts the work the test's
 * thread did, which waiting does not inflate; the first describe below
 * proves it can fail and that waiting does not count.
 */
import { describe, expect, test } from "vitest";

import { cpuWorkOf } from "../../engine/src/shared/run-cpu.ts";

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

describe("the measurement can fail, and waiting does not count", () => {
  test("30 ms of computing measures at least 25 ms of CPU work", () => {
    const burnt = cpuWorkOf(() => {
      const start = process.threadCpuUsage();
      let x = 0;
      for (;;) {
        const used = process.threadCpuUsage(start);
        if ((used.user + used.system) / 1000 >= 30) break;
        x += 1;
      }
      expect(x).toBeGreaterThan(0);
    });
    expect(burnt).toBeGreaterThanOrEqual(25);
  });

  test("100 ms of waiting measures under 16 ms (the smallest budget here)", () => {
    const waited = cpuWorkOf(() => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    });
    expect(waited).toBeLessThan(16);
  });
});

describe("30k-event budgets", () => {
  test("full-window client binning (600 bins) < 100ms", () => {
    let count = 0;
    const work = cpuWorkOf(() => {
      count = binEvents(events, coverage, 600).eventCount;
    });
    expect(count).toBe(30_000);
    expect(work).toBeLessThan(100);
  });

  test("zoom rebin of a sub-window < 100ms", () => {
    const source = clientWindowSource(events);
    const zoomed = zoomWindow(coverage, coverage.t0 + 3600_000, 0.1, coverage);
    let span = Number.POSITIVE_INFINITY;
    const work = cpuWorkOf(() => {
      const bins = source.bins(zoomed, 600);
      span = bins.window.t1 - bins.window.t0;
    });
    expect(span).toBeLessThan(coverage.t1 - coverage.t0);
    expect(work).toBeLessThan(100);
  });

  test("causal band build over a zoomed window < 100ms", () => {
    const source = clientWindowSource(events);
    const zoomed = { t0: coverage.t0, t1: coverage.t0 + 600_000 }; // 10 min
    let bands = 0;
    const work = cpuWorkOf(() => {
      bands = buildCausalBands(source.eventsIn(zoomed)).length;
    });
    expect(bands).toBeGreaterThan(0);
    expect(work).toBeLessThan(100);
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
    expect(cpuWorkOf(() => paintSweep(ctx, frame))).toBeLessThan(16);
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
  test("1200 pointer ticks (a full-width drag) cost < 16 ms of CPU work in the emitter path", () => {
    const emitter = frameCoalesced<number>(
      () => {},
      (cb) => {
        void cb;
        return 1;
      },
      () => {},
    );
    const work = cpuWorkOf(() => {
      for (let i = 0; i < 1200; i++) emitter.offer(i);
    });
    expect(work).toBeLessThan(16);
    // …and the 1200 ticks became ONE scheduled frame, not 1200 navigations.
    expect(emitter.stats().offered).toBe(1200);
    expect(emitter.stats().frames).toBe(1);
    assertNavigationCoalesced(emitter.stats());
  });

  test("resolving the event at-or-before an instant over 30k events is O(log n) — 1200 resolutions < 16ms", () => {
    let hits = 0;
    const work = cpuWorkOf(() => {
      for (let i = 0; i < 1200; i++) {
        const at = coverage.t0 + ((coverage.t1 - coverage.t0) * i) / 1200;
        if (eventAtOrBefore(events, at) !== null) hits += 1;
      }
    });
    expect(hits).toBeGreaterThan(1000);
    expect(work).toBeLessThan(16);
  });
});
