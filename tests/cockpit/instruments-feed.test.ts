// @vitest-environment jsdom
/**
 * INSTRUMENTS — the live feed (DESIGN-COCKPIT-V2 §8.2), state-machine
 * level: ingestion honesty (measured points only, no fabricated fill),
 * ref-counted acquisition (nothing polls for nobody), monitor projection
 * (§1.4 references with a real asOf) and the storage convention.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  acquireInstrumentsFeed,
  bindInstrumentsIngest,
  bindMonitorsToShell,
  collectingSince,
  displaceMonitor,
  feedRunning,
  lastFeedError,
  loadPinnedFromStorage,
  pinMonitor,
  pinnedMonitors,
  projectMonitors,
  resetInstrumentsFeed,
  setInstrumentsReader,
  signalCurrent,
  signalHistory,
  unpinMonitor,
} from "../../src/cockpit/rooms/instruments-feed.ts";
import {
  MONITORS_STORAGE_KEY,
  SIGNALS_POLL_MS,
  SIGNAL_RING_CAPACITY,
} from "../../src/cockpit/rooms/instruments-config.ts";
import { setUiSchema, setUiSchemaValues, resetUiSchema } from "../../src/state/schema-store.ts";
import { persistGet, persistSet } from "../../src/state/persistence.ts";
import type { ShellApi } from "../../src/cockpit/shell/contract.ts";
import type { UiSchema } from "../../shared/ui-schema.ts";

const SCHEMA = {
  version: "v",
  modules: [],
  menus: [],
  panels: [],
  widgets: [],
  settings: [],
  actions: [],
  signals: [
    { id: "context.utilization", module: "context", name: "Utilization", description: "d", type: "gauge", unit: "ratio" },
    { id: "tools.callCount", module: "tools", name: "Call Count", description: "d", type: "counter", unit: "count" },
    { id: "context.compactStrategy", module: "context", name: "Compact Strategy", description: "d", type: "string" },
  ],
} as unknown as UiSchema;

const snapshot = (pairs: Readonly<Record<string, number | string | boolean>>) => ({
  signals: Object.entries(pairs).map(([id, value]) => ({ id, value })),
  customizations: [],
});

beforeEach(() => {
  vi.useFakeTimers();
  resetInstrumentsFeed();
  resetUiSchema();
  localStorage.clear();
  setUiSchema(SCHEMA);
  bindInstrumentsIngest();
});

afterEach(() => {
  resetInstrumentsFeed();
  resetUiSchema();
  vi.useRealTimers();
});

// ── ingestion ─────────────────────────────────────────────────────────────

describe("ingestion — measured points only", () => {
  test("a numeric signal accrues ring-buffer points; a string signal does not", () => {
    setUiSchemaValues(snapshot({ "context.utilization": 0.1, "context.compactStrategy": "oldest" }));
    setUiSchemaValues(snapshot({ "context.utilization": 0.2, "context.compactStrategy": "oldest" }));
    expect(signalHistory.get()["context.utilization"]).toHaveLength(2);
    expect(signalHistory.get()["context.compactStrategy"]).toBeUndefined();
    // …but the string's CURRENT value is measured and readable.
    expect(signalCurrent.get()["context.compactStrategy"]!.v).toBe("oldest");
  });

  test("a signal missing from a snapshot keeps its LAST measurement and asOf", () => {
    setUiSchemaValues(snapshot({ "tools.callCount": 12 }));
    const first = signalCurrent.get()["tools.callCount"]!;
    vi.advanceTimersByTime(10_000);
    setUiSchemaValues(snapshot({ "context.utilization": 0.5 }));
    const after = signalCurrent.get()["tools.callCount"]!;
    expect(after.v).toBe(12);
    expect(after.t).toBe(first.t);
    expect(signalHistory.get()["tools.callCount"]).toHaveLength(1);
  });

  test("MUTATION: nothing fabricates a zero for an unseen signal", () => {
    setUiSchemaValues(snapshot({ "tools.callCount": 12 }));
    expect(signalCurrent.get()["context.utilization"]).toBeUndefined();
    expect(signalHistory.get()["context.utilization"]).toBeUndefined();
  });

  test("a non-finite served value never enters the ring buffer", () => {
    setUiSchemaValues(snapshot({ "tools.callCount": Number.NaN }));
    expect(signalHistory.get()["tools.callCount"]).toBeUndefined();
    // it IS a received sample though — the cell renders its honest dash
    expect(signalCurrent.get()["tools.callCount"]).toBeDefined();
  });

  test("the ring buffer is bounded by its declared capacity", () => {
    for (let i = 0; i < SIGNAL_RING_CAPACITY + 5; i += 1) {
      vi.advanceTimersByTime(SIGNALS_POLL_MS);
      setUiSchemaValues(snapshot({ "tools.callCount": i }));
    }
    expect(signalHistory.get()["tools.callCount"]).toHaveLength(SIGNAL_RING_CAPACITY);
  });
});

// ── acquisition ───────────────────────────────────────────────────────────

describe("acquisition — ref-counted; nothing polls for nobody", () => {
  test("first acquire samples immediately and then on cadence", async () => {
    let calls = 0;
    setInstrumentsReader({ values: async () => void (calls += 1) });
    const release = acquireInstrumentsFeed();
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(SIGNALS_POLL_MS * 2);
    expect(calls).toBe(3);
    release();
    await vi.advanceTimersByTimeAsync(SIGNALS_POLL_MS * 3);
    expect(calls).toBe(3);
  });

  test("two holders keep ONE cadence; the last release stops it", async () => {
    let calls = 0;
    setInstrumentsReader({ values: async () => void (calls += 1) });
    const a = acquireInstrumentsFeed();
    const b = acquireInstrumentsFeed();
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(1); // one immediate sample, not two
    await vi.advanceTimersByTimeAsync(SIGNALS_POLL_MS);
    expect(calls).toBe(2);
    a();
    expect(feedRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(SIGNALS_POLL_MS);
    expect(calls).toBe(3);
    b();
    expect(feedRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(SIGNALS_POLL_MS * 3);
    expect(calls).toBe(3);
  });

  test("collectingSince is a real instant, set once", async () => {
    setInstrumentsReader({ values: async () => {} });
    expect(collectingSince.get()).toBeNull();
    const r = acquireInstrumentsFeed();
    const first = collectingSince.get();
    expect(typeof first).toBe("number");
    r();
    acquireInstrumentsFeed()();
    expect(collectingSince.get()).toBe(first);
  });

  test("a failing poll records plain words and clears on recovery", async () => {
    let fail = true;
    setInstrumentsReader({
      values: async () => {
        if (fail) throw new Error("nope");
      },
    });
    const release = acquireInstrumentsFeed();
    await vi.advanceTimersByTimeAsync(1);
    expect(lastFeedError.get()).toBe("not available right now");
    fail = false;
    await vi.advanceTimersByTimeAsync(SIGNALS_POLL_MS);
    expect(lastFeedError.get()).toBeNull();
    release();
  });

  test("a double release does not unbalance the ref count", async () => {
    let calls = 0;
    setInstrumentsReader({ values: async () => void (calls += 1) });
    const a = acquireInstrumentsFeed();
    const b = acquireInstrumentsFeed();
    a();
    a(); // idempotent
    expect(feedRunning()).toBe(true);
    b();
    expect(feedRunning()).toBe(false);
  });
});

// ── monitors ──────────────────────────────────────────────────────────────

describe("monitors — references with a real asOf, ≤4, persisted", () => {
  test("projection formats from the same measured sample as the cell", () => {
    setUiSchemaValues(snapshot({ "context.utilization": 0.16 }));
    pinMonitor("context.utilization");
    const [m] = projectMonitors(pinnedMonitors.get(), signalCurrent.get(), () => {});
    expect(m!.label).toBe("Utilization");
    expect(m!.value).toBe("16%");
    expect(m!.asOf).toBe(signalCurrent.get()["context.utilization"]!.t);
  });

  test("an unmeasured pin says 'collecting' and still carries a real asOf", () => {
    acquireInstrumentsFeed();
    pinMonitor("tools.callCount");
    const [m] = projectMonitors(pinnedMonitors.get(), signalCurrent.get(), () => {});
    expect(m!.value).toBe("collecting");
    expect(m!.asOf).toBe(collectingSince.get());
  });

  test("the projection never exceeds the cap even if the store were over it", () => {
    const over = Array.from({ length: 9 }, (_, i) => ({ signalId: `s${i}`, pinnedAt: i }));
    expect(projectMonitors(over, {}, () => {})).toHaveLength(4);
  });

  test("pinning holds the feed open so monitors live-update with the room closed", async () => {
    let calls = 0;
    setInstrumentsReader({ values: async () => void (calls += 1) });
    pinMonitor("context.utilization");
    await vi.advanceTimersByTimeAsync(1);
    expect(feedRunning()).toBe(true);
    const before = calls;
    await vi.advanceTimersByTimeAsync(SIGNALS_POLL_MS);
    expect(calls).toBeGreaterThan(before);
    unpinMonitor("context.utilization");
    expect(feedRunning()).toBe(false);
  });

  test("displace swaps in place, preserving the other three slots' order", () => {
    for (const id of ["a", "b", "c", "d"]) pinMonitor(id);
    displaceMonitor("c", "e");
    expect(pinnedMonitors.get().map((m) => m.signalId)).toEqual(["a", "b", "e", "d"]);
  });

  test("the shell receives the monitor set and re-receives it on every change", () => {
    const pushed: unknown[][] = [];
    const shell = {
      setMonitors: (l: readonly unknown[]) => pushed.push([...l]),
      openRoom: () => {},
    } as unknown as ShellApi;
    bindMonitorsToShell(shell);
    const initial = pushed.length;
    pinMonitor("context.utilization");
    setUiSchemaValues(snapshot({ "context.utilization": 0.5 }));
    expect(pushed.length).toBeGreaterThan(initial + 1);
    const last = pushed[pushed.length - 1]! as { value: string }[];
    expect(last[0]!.value).toBe("50%");
  });

  test("pins survive a reload through the app's persistence owner", () => {
    pinMonitor("context.utilization");
    const raw = persistGet(MONITORS_STORAGE_KEY)!;
    expect(JSON.parse(raw)).toEqual([
      { signalId: "context.utilization", pinnedAt: expect.any(Number) },
    ]);
  });

  test("MUTATION: a corrupt or foreign stored blob degrades to no pins", () => {
    for (const blob of ["{not json", '"a string"', "42", '[{"nope":1}]']) {
      persistSet(MONITORS_STORAGE_KEY, blob);
      expect(loadPinnedFromStorage(), blob).toEqual([]);
    }
  });

  test("a stored over-long set is capped on load, not rendered over the cap", () => {
    persistSet(
      MONITORS_STORAGE_KEY,
      JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ signalId: `s${i}`, pinnedAt: i }))),
    );
    expect(loadPinnedFromStorage()).toHaveLength(4);
  });

  test("a valid stored set round-trips", () => {
    pinMonitor("context.utilization");
    pinMonitor("tools.callCount");
    expect(loadPinnedFromStorage().map((m) => m.signalId)).toEqual([
      "context.utilization",
      "tools.callCount",
    ]);
  });
});
