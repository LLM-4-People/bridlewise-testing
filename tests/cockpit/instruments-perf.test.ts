// @vitest-environment node
/**
 * INSTRUMENTS — the CI-enforced latency budget (§1.5 F2, §8: "any
 * view/room/scope open < 200ms").
 *
 * The room's OPEN cost is CPU only: grouping the served registry and
 * resolving every cell's verbs from the schema. Values arrive after, so
 * the honest bound to enforce is that whole preparation over a field
 * LARGER than the live registry (110 signals → 400 here, with headroom).
 *
 * The stopwatch is MUTATION-TESTED: a deliberately slowed resolution
 * measured by the same harness exceeds the budget — a guard that cannot
 * fail measures nothing.
 */
import { describe, expect, test } from "vitest";

import { cpuWorkOf, threadCpuWorkMs } from "../../engine/src/shared/run-cpu.ts";

import {
  buildGroups,
  resolveVerbs,
  sparkSegments,
  type SignalPoint,
} from "../../src/cockpit/rooms/instruments-data.ts";
import {
  SIGNALS_POLL_MS,
  SPARK_GAP_FACTOR,
  SIGNAL_RING_CAPACITY,
} from "../../src/cockpit/rooms/instruments-config.ts";
import type { SettingEntry, SignalEntry, UiSchema } from "../../shared/ui-schema.ts";

/** The room-open CPU budget — half the §1.5 200ms room-open bound, since
 * the render of fixed-geometry cells is the other half. */
const OPEN_BUDGET_MS = 100;
/** A full repaint pass over every cell's spark segmentation. */
const SEGMENT_BUDGET_MS = 16;

const MODULES = ["awareness", "bias", "context", "editor", "hallucination", "learning",
  "memory", "quality", "safety", "search", "tools", "extra"];

const signals: SignalEntry[] = Array.from({ length: 400 }, (_, i) => ({
  id: `${MODULES[i % MODULES.length]}.signal${i}`,
  module: MODULES[i % MODULES.length]!,
  name: `Signal ${i}`,
  description: "d",
  type: i % 3 === 0 ? "counter" : "gauge",
  unit: "count",
}));

const settings: SettingEntry[] = signals
  .filter((_, i) => i % 5 === 0)
  .map((s, i) => ({
    id: `cust.${s.id}`,
    label: s.name,
    description: "d",
    type: "number",
    default: 1,
    customizationId: s.id,
    order: i,
  }));

const schema = {
  version: "v",
  modules: MODULES.map((m, i) => ({ id: `sys.${m}`, title: `${m} signals`, group: "system", order: i })),
  menus: [], panels: [], widgets: [],
  settings,
  actions: [],
  signals,
  blockActions: {},
} as unknown as UiSchema;

/** Best-of-N CPU WORK, never wall time (NO-LOAD-BLOCK): a busy host makes
 * the pass wait for a core, which is not its cost (engine/src/shared/run-cpu.ts). */
function bestOf(n: number, fn: () => void): number {
  return cpuWorkOf(fn, n);
}

function openOnce(): void {
  const groups = buildGroups(schema);
  for (const g of groups) {
    for (const s of g.signals) resolveVerbs(s, schema.settings, schema.blockActions);
  }
}

describe("room open stays inside the budget", () => {
  test(`grouping + verb resolution over 400 signals < ${OPEN_BUDGET_MS}ms`, () => {
    openOnce(); // warm
    expect(bestOf(5, openOnce)).toBeLessThan(OPEN_BUDGET_MS);
  });

  test("MUTATION: the stopwatch can fail — a slowed pass exceeds the budget", () => {
    const slow = (): void => {
      openOnce();
      // The deliberate slowness is CPU WORK, so the plant is the same work at any load.
      const until = threadCpuWorkMs() + OPEN_BUDGET_MS + 20;
      while (threadCpuWorkMs() < until) {
        /* deliberate stall */
      }
    };
    expect(bestOf(1, slow)).toBeGreaterThan(OPEN_BUDGET_MS);
  });
});

describe("a full spark repaint stays inside one frame", () => {
  const buffers: SignalPoint[][] = signals.map((_, s) =>
    Array.from({ length: SIGNAL_RING_CAPACITY }, (_, i) => ({
      t: i * SIGNALS_POLL_MS + (i === 30 ? 120_000 : 0),
      v: (i * 7 + s) % 100,
    })),
  );

  test(`segmenting every cell's buffer < ${SEGMENT_BUDGET_MS}ms`, () => {
    const pass = (): void => {
      for (const b of buffers) sparkSegments(b, SIGNALS_POLL_MS, SPARK_GAP_FACTOR);
    };
    pass();
    expect(bestOf(5, pass)).toBeLessThan(SEGMENT_BUDGET_MS);
  });
});
