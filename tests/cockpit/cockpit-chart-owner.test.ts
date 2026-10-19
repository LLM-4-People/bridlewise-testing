// @vitest-environment jsdom
/**
 * THE NO-BROKEN-CHART LAW (DESIGN-COCKPIT-V2 §8.3) — the guard the spec
 * names by file: `cockpit-chart-owner.test.ts`.
 *
 *   "A time series renders only from its measured ring buffer. No axis
 *    without data; no interpolation across gaps (gaps render as gaps); no
 *    chart placeholder states. Guard: the spark component throws in dev if
 *    fed <2 points, and the cell renders the absence state instead."
 *
 * Enforced on three levels, each MUTATION-TESTED (a guard that cannot fail
 * proves nothing):
 *   A. the Spark COMPONENT throws in dev when fed <2 measured points;
 *   B. with fewer than two measured points the CELL renders the measured
 *      value alone (no chart, no placeholder); the absence state is the
 *      no-sample case only — and never a numeral for an unmeasured signal;
 *   C. the segmentation is gap-honest: no segment spans a gap, so no line
 *      is ever drawn across un-measured time;
 *   D. a source scan: no chart component may be mounted without its
 *      measured points gated by `sparkRenderable` (a future cell that
 *      forgets the gate fails here, not in the field).
 */
import { describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import Spark from "../../src/cockpit/rooms/Spark.svelte";
import InstrumentCell from "../../src/cockpit/rooms/InstrumentCell.svelte";
import {
  formatMeasuredValue,
  sparkRenderable,
  sparkSegments,
  type SignalPoint,
} from "../../src/cockpit/rooms/instruments-data.ts";
import {
  SIGNALS_POLL_MS,
  SPARK_GAP_FACTOR,
  SPARK_MIN_POINTS,
} from "../../src/cockpit/rooms/instruments-config.ts";
import { read, relpath, walk } from "../helpers/source-scan.ts";
import type { SignalEntry } from "../../shared/ui-schema.ts";

const T = Date.parse("2026-07-26T14:02:00Z");

const SIGNAL: SignalEntry = {
  id: "context.utilization",
  module: "context",
  name: "Utilization",
  description: "Fraction of the context window currently in use (0..1).",
  type: "gauge",
  unit: "ratio",
};

function pts(n: number, stepMs = SIGNALS_POLL_MS): SignalPoint[] {
  return Array.from({ length: n }, (_, i) => ({ t: T + i * stepMs, v: i }));
}

const CELL_BASE = {
  signal: SIGNAL,
  verbs: [],
  collectingSince: T,
  pinned: false,
  sheetAvailable: false,
  onVerb: () => {},
  onPin: () => {},
};

// ── A. the component throws in dev when fed <2 points ─────────────────────

describe("A — Spark throws in dev if fed fewer than 2 measured points", () => {
  test("zero points throws", () => {
    expect(() => render(Spark, { props: { points: [] } })).toThrow(/cannot chart/i);
    cleanup();
  });

  test("one point throws — a single measurement is not a series", () => {
    expect(() => render(Spark, { props: { points: pts(1) } })).toThrow(/cannot chart/i);
    cleanup();
  });

  test("two points render (the law's exact floor, not one above it)", () => {
    const { container } = render(Spark, { props: { points: pts(SPARK_MIN_POINTS) } });
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(container.querySelector(".spark")?.getAttribute("data-points")).toBe("2");
    cleanup();
  });

  test("the rendered spark states its real measured count (no padding)", () => {
    const { getByText } = render(Spark, { props: { points: pts(7) } });
    expect(getByText(/7 measured points/)).toBeTruthy();
    cleanup();
  });
});

// ── B. the cell renders the absence state instead ─────────────────────────

describe("B — the cell renders absence, never a broken chart or a fake number", () => {
  test("no sample at all: absence words, no numeral, no canvas", () => {
    const { container } = render(InstrumentCell, {
      props: { ...CELL_BASE, sample: undefined, points: [] },
    });
    expect(container.querySelector("canvas")).toBeNull();
    expect(container.querySelector(".value")).toBeNull();
    expect(container.textContent).toContain("collecting since");
    cleanup();
  });

  test("before the feed ever ran the absence is 'not measured yet'", () => {
    const { container } = render(InstrumentCell, {
      props: { ...CELL_BASE, collectingSince: null, sample: undefined, points: [] },
    });
    expect(container.textContent).toContain("not measured yet");
    cleanup();
  });

  test("ONE measured point: the value renders, the spark does NOT", () => {
    const { container } = render(InstrumentCell, {
      props: { ...CELL_BASE, sample: { v: 0.16, t: T }, points: pts(1) },
    });
    expect(container.querySelector(".value")?.textContent).toBe("16%");
    expect(container.querySelector("canvas")).toBeNull();
    // The measured value owns the readout alone: no chart, and no
    // placeholder words beside it (the redesign; DESIGN-COCKPIT-V2 §8.2).
    expect(container.querySelector(".readout")?.textContent?.trim()).toBe("16%");
    cleanup();
  });

  test("two measured points: the spark appears, at the floor", () => {
    const { container } = render(InstrumentCell, {
      props: { ...CELL_BASE, sample: { v: 0.16, t: T }, points: pts(2) },
    });
    expect(container.querySelector("canvas")).not.toBeNull();
    cleanup();
  });

  test("a non-numeric signal never charts (no honest line exists)", () => {
    const boolSignal: SignalEntry = { ...SIGNAL, id: "tools.failClosed", type: "boolean", unit: undefined };
    const { container } = render(InstrumentCell, {
      props: { ...CELL_BASE, signal: boolSignal, sample: { v: true, t: T }, points: [] },
    });
    expect(container.querySelector("canvas")).toBeNull();
    expect(container.querySelector(".value")?.textContent).toBe("yes");
    cleanup();
  });

  test("MUTATION: an unmeasured value pushed at the numeral formatter throws", () => {
    // The mechanical enforcement of "unmeasured value rendered as a number
    // → fail": the formatter refuses undefined rather than printing 0/—.
    expect(() => formatMeasuredValue(undefined, "gauge", "ratio")).toThrow(/absence state/i);
  });
});

// ── C. gaps render as gaps — never interpolated ───────────────────────────

describe("C — no interpolation across gaps", () => {
  test("contiguous cadence samples are ONE segment", () => {
    expect(sparkSegments(pts(5), SIGNALS_POLL_MS, SPARK_GAP_FACTOR)).toHaveLength(1);
  });

  test("a silence longer than the gap factor SPLITS the series", () => {
    const series: SignalPoint[] = [
      { t: T, v: 1 },
      { t: T + SIGNALS_POLL_MS, v: 2 },
      // nothing measured for a minute — the room was closed
      { t: T + SIGNALS_POLL_MS + 60_000, v: 3 },
      { t: T + SIGNALS_POLL_MS + 65_000, v: 4 },
    ];
    const segs = sparkSegments(series, SIGNALS_POLL_MS, SPARK_GAP_FACTOR);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toHaveLength(2);
    expect(segs[1]).toHaveLength(2);
  });

  test("MUTATION: a joiner that ignored gaps would produce ONE segment — it does not", () => {
    const series: SignalPoint[] = [
      { t: T, v: 1 },
      { t: T + 10 * 60_000, v: 2 },
    ];
    const segs = sparkSegments(series, SIGNALS_POLL_MS, SPARK_GAP_FACTOR);
    expect(segs.length).toBeGreaterThan(1);
    for (const seg of segs) expect(seg).toHaveLength(1);
  });

  test("no segment ever spans more than the declared gap bound", () => {
    const series: SignalPoint[] = [
      { t: T, v: 1 },
      { t: T + SIGNALS_POLL_MS, v: 2 },
      { t: T + 40_000, v: 3 },
    ];
    for (const seg of sparkSegments(series, SIGNALS_POLL_MS, SPARK_GAP_FACTOR)) {
      for (let i = 1; i < seg.length; i += 1) {
        expect(seg[i]!.t - seg[i - 1]!.t).toBeLessThanOrEqual(SIGNALS_POLL_MS * SPARK_GAP_FACTOR);
      }
    }
  });

  test("sparkRenderable IS the §8.3 floor, and mutation-proof", () => {
    expect(sparkRenderable([])).toBe(false);
    expect(sparkRenderable(pts(1))).toBe(false);
    expect(sparkRenderable(pts(2))).toBe(true);
    expect(SPARK_MIN_POINTS).toBe(2);
  });
});

// ── D. source scan: no chart mounted without the measured gate ────────────

/** Every `<Spark` mount in a source that is NOT guarded by the renderable
 * gate somewhere in the same file. */
export function findUngatedSparks(src: string): string[] {
  const mounts = src.match(/<Spark\b[^>]*>/g) ?? [];
  if (mounts.length === 0) return [];
  const gated = /sparkRenderable\s*\(/.test(src);
  return gated ? [] : mounts.map((m) => m.slice(0, 80));
}

describe("D — every chart mount is gated on measured points", () => {
  test("no cockpit source mounts a Spark without the renderable gate", () => {
    const offenders: string[] = [];
    for (const f of walk("src/cockpit", { exts: [".svelte"] })) {
      for (const hit of findUngatedSparks(read(f))) offenders.push(`${relpath(f)}: ${hit}`);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("MUTATION: an ungated mount is flagged", () => {
    expect(findUngatedSparks(`<Spark points={pts} />`)).toHaveLength(1);
  });

  test("a gated mount is NOT flagged (no false positive)", () => {
    const good = `{#if sparkRenderable(points)}<Spark {points} />{/if}`;
    expect(findUngatedSparks(good)).toEqual([]);
  });

  test("a source with no chart at all is not flagged", () => {
    expect(findUngatedSparks(`<div>no charts here</div>`)).toEqual([]);
  });
});

// ── Two floors, one law ───────────────────────────────────────────────────

describe("the law holds in BOTH builds — loudly in dev, silently in prod", () => {
  /**
   * `import.meta.env.DEV` is compile-time in the bundle, so a runtime test
   * cannot flip it — stating that is the honest scope. What IS testable at
   * runtime is that the PAINT path carries its own floor independent of
   * the throw: `paint()` returns before touching a context when fed <2
   * points, so a production build renders an empty (never a broken) spark.
   * The source scan below pins that second floor's existence.
   */
  test("the paint path has its own <2-point floor, not only the dev throw", () => {
    const src = read("src/cockpit/rooms/Spark.svelte");
    const paintBody = src.slice(src.indexOf("function paint("));
    const firstStatement = paintBody.slice(0, paintBody.indexOf("\n", paintBody.indexOf("{")) + 200);
    expect(firstStatement).toMatch(/series\.length\s*<\s*SPARK_MIN_POINTS/);
    expect(firstStatement).toMatch(/return/);
  });

  test("the throw names the law so a future reader cannot mistake it for a bug", () => {
    const src = read("src/cockpit/rooms/Spark.svelte");
    expect(src).toMatch(/no-broken-chart law/);
  });
});
