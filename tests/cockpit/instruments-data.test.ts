// @vitest-environment node
/**
 * INSTRUMENTS — the pure helpers (DESIGN-COCKPIT-V2 §8.2/§8.3), unit-level
 * and MUTATION-TESTED: the measured ring buffer, value formatting's
 * honesty floor, abnormal-state resolution from DECLARED thresholds only,
 * the pinned-set arithmetic (≤4 with the displace ask), and the honest
 * counts the room's header states.
 */
import { describe, expect, test } from "vitest";

import {
  MAX_PINNED,
  abnormalState,
  asOfTime,
  buildGroups,
  countInstruments,
  formatMeasuredValue,
  groupTitle,
  isPinnedMonitor,
  UNDECLARED_MODULE,
  pinOutcome,
  pushPoint,
  templateBuildable,
  type PinnedMonitor,
  type SignalPoint,
} from "../../src/cockpit/rooms/instruments-data.ts";
import { logTime } from "../../src/cockpit/shell/config.ts";
import { SIGNAL_RING_CAPACITY } from "../../src/cockpit/rooms/instruments-config.ts";
import type { SignalEntry, UiSchema } from "../../shared/ui-schema.ts";

const S = (over: Partial<SignalEntry> = {}): SignalEntry => ({
  id: "context.utilization",
  module: "context",
  name: "Utilization",
  description: "d",
  type: "gauge",
  unit: "ratio",
  ...over,
});

// ── the ring buffer ───────────────────────────────────────────────────────

describe("the measured ring buffer", () => {
  test("appends in order and never exceeds capacity", () => {
    let buf: readonly SignalPoint[] = [];
    for (let i = 0; i < SIGNAL_RING_CAPACITY + 20; i += 1) {
      buf = pushPoint(buf, { t: i, v: i }, SIGNAL_RING_CAPACITY);
    }
    expect(buf).toHaveLength(SIGNAL_RING_CAPACITY);
    expect(buf[buf.length - 1]!.v).toBe(SIGNAL_RING_CAPACITY + 19);
    for (let i = 1; i < buf.length; i += 1) expect(buf[i]!.t).toBeGreaterThan(buf[i - 1]!.t);
  });

  test("MUTATION: the OLDEST is what falls off, not the newest", () => {
    let buf: readonly SignalPoint[] = [];
    for (const v of [1, 2, 3]) buf = pushPoint(buf, { t: v, v }, 2);
    expect(buf.map((p) => p.v)).toEqual([2, 3]);
  });

  test("push is pure — the input buffer is never mutated", () => {
    const buf: readonly SignalPoint[] = [{ t: 1, v: 1 }];
    pushPoint(buf, { t: 2, v: 2 }, 4);
    expect(buf).toHaveLength(1);
  });
});

// ── formatting ────────────────────────────────────────────────────────────

describe("value formatting — measured only, plain, tabular", () => {
  test("shares render as percents, multiples in times, timers as durations, counters compactly", () => {
    expect(formatMeasuredValue(0.16, "gauge", "ratio")).toBe("16%");
    // A multiple is its own declared unit — rendered in the leaf's own
    // words ("4 times"), never rescaled into a percent of an unnamed
    // referent ("400%").
    expect(formatMeasuredValue(4, "gauge", "times")).toBe("4 times");
    expect(formatMeasuredValue(420, "timer", "ms")).toBe("420ms");
    expect(formatMeasuredValue(9500, "timer", "ms")).toBe("9.5s");
    expect(formatMeasuredValue(12, "counter", "count")).toBe("12");
    expect(formatMeasuredValue(32768, "gauge", "tokens")).toBe("32.8k tokens");
  });

  test("booleans and strings render in words, never as numbers", () => {
    expect(formatMeasuredValue(true, "boolean")).toBe("yes");
    expect(formatMeasuredValue(false, "boolean")).toBe("no");
    expect(formatMeasuredValue("oldest", "string")).toBe("oldest");
  });

  test("long measured strings retain their meaningful final characters for content-fitting cells", () => {
    const value = "x".repeat(80) + "-actual-final-value";
    expect(formatMeasuredValue(value, "string")).toBe(value);
  });

  test("MUTATION: an UNMEASURED value can never become a numeral", () => {
    expect(() => formatMeasuredValue(undefined, "gauge")).toThrow(/absence state/i);
  });

  test("a non-finite measurement renders as the honest dash, not 0", () => {
    expect(formatMeasuredValue(Number.NaN, "gauge")).toBe("—");
    expect(formatMeasuredValue(Number.POSITIVE_INFINITY, "gauge")).toBe("—");
  });

  test("asOf renders the measurement's own wall time", () => {
    expect(asOfTime(Date.parse("2026-07-26T14:02:33Z"))).toMatch(/^\d{2}:\d{2}$/);
  });
});

// ── abnormal state ────────────────────────────────────────────────────────

describe("abnormal state comes ONLY from declared thresholds", () => {
  test("no declaration → no abnormal state, at any value", () => {
    expect(abnormalState(S(), 0.999)).toBeNull();
    expect(abnormalState(S(), 1e9)).toBeNull();
  });

  test("a declared warn/alarm is honored with a plain-words reason", () => {
    const declared = { ...S(), thresholds: { warnAbove: 0.8, alarmAbove: 0.95 } } as SignalEntry;
    expect(abnormalState(declared, 0.5)).toBeNull();
    expect(abnormalState(declared, 0.85)?.level).toBe("warn");
    expect(abnormalState(declared, 0.97)?.level).toBe("alarm");
    expect(abnormalState(declared, 0.97)?.reason).toMatch(/measured 0\.97/);
  });

  test("an UNMEASURED value is never abnormal (absence cannot cross)", () => {
    const declared = { ...S(), thresholds: { alarmAbove: 0 } } as SignalEntry;
    expect(abnormalState(declared, undefined)).toBeNull();
    expect(abnormalState(declared, "text")).toBeNull();
    expect(abnormalState(declared, true)).toBeNull();
  });

  test("below-thresholds work too (a gauge can be abnormally LOW)", () => {
    const declared = { ...S(), thresholds: { warnBelow: 0.1, alarmBelow: 0.01 } } as SignalEntry;
    expect(abnormalState(declared, 0.05)?.level).toBe("warn");
    expect(abnormalState(declared, 0.005)?.level).toBe("alarm");
    expect(abnormalState(declared, 0.5)).toBeNull();
  });

  test("MUTATION: a malformed thresholds blob declares nothing", () => {
    for (const bad of [null, "0.8", [], { warnAbove: "0.8" }, {}]) {
      expect(abnormalState({ ...S(), thresholds: bad } as SignalEntry, 0.99)).toBeNull();
    }
  });
});

// ── grouping + served names ───────────────────────────────────────────────

describe("grouping by feature module, named by the served display path", () => {
  const schema = {
    version: "v",
    modules: [{ id: "sys.context", title: "Context signals" }],
    menus: [], panels: [], widgets: [], settings: [], actions: [],
    signals: [S(), S({ id: "tools.callCount", module: "tools", name: "Call Count" })],
  } as unknown as UiSchema;

  test("groups are alphabetical and complete", () => {
    expect(buildGroups(schema).map((g) => g.module)).toEqual(["context", "tools"]);
  });

  test("a served module title wins; an unserved namespace humanizes", () => {
    expect(groupTitle("context", schema.modules)).toBe("Context signals");
    expect(groupTitle("tools", schema.modules)).toBe("Tools");
    expect(groupTitle("some-new-thing", [])).toBe("Some new thing");
  });

  test("a null schema is an empty room, not a crash", () => {
    expect(buildGroups(null)).toEqual([]);
  });

  test("a signal declaring no module groups under the honest catch-all", () => {
    const noModule = {
      ...schema,
      signals: [S({ id: "orphan.thing", module: "" })],
    } as unknown as UiSchema;
    const groups = buildGroups(noModule);
    expect(groups.map((g) => g.module)).toEqual([UNDECLARED_MODULE]);
    // …and it is NOT invented from the id's namespace prefix.
    expect(groups[0]!.module).not.toBe("orphan");
  });
});

// ── verb input buildability ───────────────────────────────────────────────

describe("an action is offered only when its input can actually be built", () => {
  test("a selection-dependent template is NOT buildable here", () => {
    expect(templateBuildable({ chatId: "$sel.chatId" })).toBe(false);
  });

  test("an absent template is not buildable (bespoke callers only)", () => {
    expect(templateBuildable(undefined)).toBe(false);
  });

  test("a literal or empty template is buildable", () => {
    expect(templateBuildable({})).toBe(true);
    expect(templateBuildable({ scope: "all" })).toBe(true);
  });

  test("MUTATION: one selection reference among literals still blocks it", () => {
    expect(templateBuildable({ scope: "all", chatId: "$sel.chatId" })).toBe(false);
  });
});

// ── the pinned set ────────────────────────────────────────────────────────

describe("the pinned set — ≤4, and the 5th asks", () => {
  const pins = (n: number): PinnedMonitor[] =>
    Array.from({ length: n }, (_, i) => ({ signalId: `s${i}`, pinnedAt: i }));

  test("under the cap a new pin is simply pinned", () => {
    expect(pinOutcome(pins(0), "x")).toBe("pinned");
    expect(pinOutcome(pins(3), "x")).toBe("pinned");
  });

  test("at the cap the outcome is 'full' — never a silent eviction", () => {
    expect(pinOutcome(pins(MAX_PINNED), "x")).toBe("full");
    expect(MAX_PINNED).toBe(4);
  });

  test("re-pinning an already-pinned signal is not a new pin", () => {
    expect(pinOutcome(pins(2), "s1")).toBe("already");
    expect(pinOutcome(pins(MAX_PINNED), "s0")).toBe("already");
  });

  test("MUTATION: the stored shape is validated on load", () => {
    expect(isPinnedMonitor({ signalId: "a", pinnedAt: 1 })).toBe(true);
    expect(isPinnedMonitor({ signalId: "a" })).toBe(false);
    expect(isPinnedMonitor({ pinnedAt: 1 })).toBe(false);
    expect(isPinnedMonitor("a")).toBe(false);
    expect(isPinnedMonitor(null)).toBe(false);
  });
});

// ── the honest counts ─────────────────────────────────────────────────────

describe("the honest counts the header states", () => {
  const signals = [S(), S({ id: "b" }), S({ id: "c" })];

  test("with the feed running, unmeasured signals are COLLECTING", () => {
    expect(countInstruments(signals, new Set(["context.utilization"]), true)).toEqual({
      declared: 3,
      measured: 1,
      collecting: 2,
      notMeasured: 0,
    });
  });

  test("before the feed ever ran, they are NOT MEASURED YET", () => {
    expect(countInstruments(signals, new Set(), false)).toEqual({
      declared: 3,
      measured: 0,
      collecting: 0,
      notMeasured: 3,
    });
  });

  test("MUTATION: the three buckets always sum to the declared field", () => {
    for (const running of [true, false]) {
      const c = countInstruments(signals, new Set(["b"]), running);
      expect(c.measured + c.collecting + c.notMeasured).toBe(c.declared);
    }
  });
});

describe("a timestamp signal renders as a point in time", () => {
  test("type=timestamp formats through the logbook's clock, never as a raw epoch", () => {
    const at = new Date("2026-07-30T14:02:07").getTime();
    const shown = formatMeasuredValue(at, "timestamp");
    // The exposure vocabulary declares `timestamp` = an INSTANT (epoch ms)
    // precisely so a generic consumer formats it as time; the raw epoch is
    // a thirteen-digit numeral nobody can read.
    expect(shown).toBe(logTime(at));
    expect(shown).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(shown).not.toContain(String(at));
  });

  test("a timer is still a duration — the two declarations stay distinct", () => {
    expect(formatMeasuredValue(1500, "timer")).toBe("1.5s");
  });
});
