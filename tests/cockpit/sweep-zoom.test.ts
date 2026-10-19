// @vitest-environment node
/**
 * Semantic zoom mapping (§6.3): one axis, always time. The zoom is
 * anchor-stable (the instant under the cursor does not move), clamped to
 * real coverage, and the representation ladder is a pure function of
 * ms-per-pixel.
 */
import { describe, expect, test } from "vitest";

import {
  MIN_WINDOW_SPAN_MS,
  ZOOM_THRESHOLDS,
  defaultView,
  msPerPx,
  panWindow,
  scrubStepMs,
  timeAtX,
  xAtTime,
  zoomLevelFor,
  zoomWindow,
} from "../../src/cockpit/sweep/zoom";
import type { SweepWindow } from "../../src/cockpit/sweep/types";

const BOUNDS: SweepWindow = { t0: 0, t1: 3_600_000 }; // 1h coverage

describe("time↔pixel mapping", () => {
  const view: SweepWindow = { t0: 1000, t1: 2000 };

  test("round-trips", () => {
    for (const x of [0, 250, 500, 999]) {
      expect(xAtTime(view, timeAtX(view, x, 1000), 1000)).toBeCloseTo(x, 6);
    }
  });

  test("edges map to edges", () => {
    expect(timeAtX(view, 0, 1000)).toBe(1000);
    expect(timeAtX(view, 1000, 1000)).toBe(2000);
    expect(xAtTime(view, 1500, 1000)).toBe(500);
  });
});

describe("zoomWindow", () => {
  test("INVARIANT: the anchor instant stays under the cursor", () => {
    const view: SweepWindow = { t0: 600_000, t1: 1_200_000 };
    const anchor = 900_000;
    const xBefore = xAtTime(view, anchor, 1200);
    for (const factor of [0.5, 0.8, 1.25, 2]) {
      const next = zoomWindow(view, anchor, factor, BOUNDS);
      const xAfter = xAtTime(next, anchor, 1200);
      expect(xAfter).toBeCloseTo(xBefore, 4);
    }
  });

  test("clamps to coverage bounds — no invented time beyond the record", () => {
    const view: SweepWindow = { t0: 0, t1: 1_800_000 };
    const zoomedOut = zoomWindow(view, 900_000, 10, BOUNDS);
    expect(zoomedOut.t0).toBeGreaterThanOrEqual(BOUNDS.t0);
    expect(zoomedOut.t1).toBeLessThanOrEqual(BOUNDS.t1);
  });

  test("never collapses below the minimum span", () => {
    let view: SweepWindow = { t0: 0, t1: 10_000 };
    for (let i = 0; i < 30; i++) view = zoomWindow(view, 5000, 0.5, BOUNDS);
    expect(view.t1 - view.t0).toBeGreaterThanOrEqual(MIN_WINDOW_SPAN_MS);
  });
});

describe("panWindow", () => {
  test("pans by the delta and clamps at coverage", () => {
    const view: SweepWindow = { t0: 1000, t1: 2000 };
    expect(panWindow(view, 500, BOUNDS)).toEqual({ t0: 1500, t1: 2500 });
    const atLeft = panWindow(view, -99_999, BOUNDS);
    expect(atLeft.t0).toBe(0);
    expect(atLeft.t1 - atLeft.t0).toBe(1000); // span preserved
  });
});

describe("zoomLevelFor — the representation ladder", () => {
  test("thresholds produce the four levels in order", () => {
    expect(zoomLevelFor(ZOOM_THRESHOLDS.runsMsPerPx * 2)).toBe("skyline");
    expect(zoomLevelFor(ZOOM_THRESHOLDS.runsMsPerPx)).toBe("runs");
    expect(zoomLevelFor(ZOOM_THRESHOLDS.causalMsPerPx)).toBe("causal");
    expect(zoomLevelFor(ZOOM_THRESHOLDS.beatsMsPerPx)).toBe("beats");
    expect(zoomLevelFor(1)).toBe("beats");
  });

  test("level derives from view + width through msPerPx", () => {
    // 1h across 1200px = 3000 ms/px → runs level.
    expect(zoomLevelFor(msPerPx(BOUNDS, 1200))).toBe("runs");
    // 30s across 1200px = 25 ms/px → beats level.
    expect(zoomLevelFor(msPerPx({ t0: 0, t1: 30_000 }, 1200))).toBe("beats");
  });
});

describe("defaultView / scrubStepMs", () => {
  test("default view spans coverage with a small empty right margin", () => {
    const v = defaultView(BOUNDS);
    expect(v.t0).toBe(0);
    expect(v.t1).toBeCloseTo(3_600_000 * 1.02, 0);
  });

  test("scrub step is one 200th of the view, at least 1ms", () => {
    expect(scrubStepMs({ t0: 0, t1: 200_000 })).toBe(1000);
    expect(scrubStepMs({ t0: 0, t1: 100 })).toBe(1);
  });
});
