// @vitest-environment node
/**
 * CLIENT TELEMETRY — the browser-side owner's arms.
 *
 * src/state/telemetry.ts captures at the browser's lowest choke points,
 * bounds its own volume, and flushes through one injectable door. These
 * arms prove the CAPTURE WIRING (a fake window's error/rejection/longtask
 * listeners produce buffered events), the VOLUME DISCIPLINE (errors are
 * never displaced; over-cap metrics are counted, never silently dropped),
 * the CORRELATION (the run's ingest-lag report carries the run, the chat
 * the stream bound and the trace the metadata frame latched — the
 * metadata-frame trace wiring's ids), the TRANSPORT (the hidden-page flush
 * goes out through the
 * beacon door as a plain string), and the NO-COLLECTION rule (a token in
 * a script URL's query string never rides along; no page content is ever
 * taken).
 *
 * Owning-test search (the discipline): the client-side telemetry owner is
 * a new subject (OF-AUDIT-2's finding) — no existing suite owns its
 * buffer/flush mechanics. The wiring arms here are the owning tests; the
 * server door's arms live in client-telemetry-block.test.ts; the action's
 * liveness proof in block-action-owner.test.ts.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";

import {
  attachClientTelemetry,
  finishRunTelemetry,
  flushTelemetry,
  flushViaBeacon,
  installTelemetrySink,
  latchRunTrace,
  noteBootMs,
  noteRunChat,
  noteRunFrameApplied,
  captureError,
  resetTelemetry,
  telemetryAttachAbsences,
  type ClientTelemetryBatch,
} from "../../src/state/telemetry";
import {
  TELEMETRY_FLUSH_MAX_EVENTS,
  TELEMETRY_RUN_METRIC_CAP,
} from "../../src/client-config";

// ── The fake window (the telemetry owner attaches through guarded
// globalThis.window reads; a fake here is the observable presence) ────────────

type FakeWindow = {
  listeners: Map<string, ((event: unknown) => void)[]>;
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  PerformanceObserver?: new (cb: (list: { getEntries(): { duration?: number }[] }) => void) => { observe: (opts: { type: string; buffered?: boolean }) => void };
  document?: { visibilityState: string };
};

function installFakeWindow(overrides: Partial<FakeWindow> = {}): FakeWindow {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const fake: FakeWindow = {
    listeners,
    addEventListener(type: string, listener: (event: unknown) => void) {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
    ...overrides,
  };
  Object.defineProperty(globalThis, "window", {
    value: fake,
    configurable: true,
    writable: true,
  });
  return fake;
}

/** Dispatch one event on the fake window. */
function dispatch(win: FakeWindow, type: string, event: unknown): void {
  for (const listener of [...(win.listeners.get(type) ?? [])]) listener(event);
}

const sinkBatches: ClientTelemetryBatch[] = [];
let sinkAccepts = true;

beforeEach(() => {
  resetTelemetry();
  sinkBatches.length = 0;
  sinkAccepts = true;
  installTelemetrySink(async (batch) => {
    sinkBatches.push(batch);
    return sinkAccepts;
  });
});

afterEach(() => {
  installTelemetrySink(null);
  // Remove the fake window so later suites start clean.
  Object.defineProperty(globalThis, "window", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  resetTelemetry();
});

describe("capture wiring — the browser's error hooks feed the buffer", () => {
  test("an uncaught script error becomes a bounded client-error fact", async () => {
    const win = installFakeWindow();
    attachClientTelemetry();
    dispatch(win, "error", {
      message: "Uncaught TypeError: boom is not a function",
      filename: "http://127.0.0.1:5173/src/app.js?t=abc123&token=secret-query-value",
      lineno: 42,
      colno: 7,
      error: { stack: "TypeError: boom is not a function\n    at boom (src/app.js:42:7)\n    at inner (src/other.js:9:1)" },
    });
    await flushTelemetry();
    expect(sinkBatches.length).toBe(1);
    const [event] = sinkBatches[0]!.events;
    expect(event?.kind).toBe("client-error");
    const facts = event?.facts as Record<string, unknown>;
    expect(facts["message"]).toBe("Uncaught TypeError: boom is not a function");
    // The source is the FILE NAME ONLY — the query string (which can carry
    // a token) never rides along.
    expect(facts["source"]).toBe("app.js");
    expect(JSON.stringify(sinkBatches)).not.toContain("secret-query-value");
    expect(facts["line"]).toBe(42);
    expect(facts["column"]).toBe(7);
    // The FIRST stack frame, bounded.
    expect(facts["stackHead"]).toContain("at boom (src/app.js:42:7)");
    expect((facts["stackHead"] as string).length).toBeLessThanOrEqual(200);
  });

  test("an unhandled promise rejection is captured with its reason", async () => {
    const win = installFakeWindow();
    attachClientTelemetry();
    dispatch(win, "unhandledrejection", {
      reason: new Error("the fetch blew up"),
    });
    await flushTelemetry();
    const [event] = sinkBatches[0]!.events;
    expect(event?.kind).toBe("client-error");
    const facts = event?.facts as Record<string, unknown>;
    expect(facts["message"]).toBe("the fetch blew up");
    expect(facts["source"]).toBe("promise");
  });

  test("a resource-load error (no script position) is NOT a page exception", async () => {
    const win = installFakeWindow();
    attachClientTelemetry();
    // Resource errors fire `error` on window with no `error` property.
    dispatch(win, "error", { message: "Failed to load resource" });
    await flushTelemetry();
    // The hook captures it as an error FACT (window.onerror semantics:
    // it did fire) but with no invented position — the honest shape.
    const [event] = sinkBatches[0]!.events;
    expect(event?.kind).toBe("client-error");
    const facts = event?.facts as Record<string, unknown>;
    expect(facts["line"]).toBeUndefined();
    expect(facts["column"]).toBeUndefined();
  });

  test("an attach with no window (SSR/tests) stays inert without throwing", () => {
    Object.defineProperty(globalThis, "window", { value: undefined, configurable: true, writable: true });
    expect(() => attachClientTelemetry()).not.toThrow();
  });

  test("an attach with no PerformanceObserver (Safari) keeps the other signals", async () => {
    const win = installFakeWindow(); // no PerformanceObserver key
    attachClientTelemetry();
    dispatch(win, "error", { message: "still captured" });
    await flushTelemetry();
    expect(sinkBatches[0]!.events[0]?.kind).toBe("client-error");
    // The dark hook is a RECORDED absence, not a swallowed one.
    expect(telemetryAttachAbsences()).toContain("longtask");
  });
});

describe("long tasks — the observer aggregates, it never buffers per entry", () => {
  test("observed long tasks flush as ONE client-metric with max + count", async () => {
    let observerCallback: ((list: { getEntries(): { duration?: number }[] }) => void) | null = null;
    const win = installFakeWindow({
      PerformanceObserver: class {
        constructor(cb: (list: { getEntries(): { duration?: number }[] }) => void) {
          observerCallback = cb;
        }
        observe(_opts: { type: string; buffered?: boolean }): void {
          // The buffered flag is the Long Tasks API's late-attach escape
          // hatch — the observer must request it.
          expect(_opts.type).toBe("longtask");
          expect(_opts.buffered).toBe(true);
        }
      },
    });
    attachClientTelemetry();
    expect(observerCallback).not.toBeNull();
    // A STORM: 500 long tasks. The observer must aggregate O(1) per entry,
    // never hold 500 buffered events.
    for (let i = 0; i < 500; i += 1) {
      observerCallback!({ getEntries: () => [{ duration: 50 + i }] });
    }
    await flushTelemetry();
    const metric = sinkBatches[0]!.events.find((e) => e.kind === "client-metric");
    expect(metric).toBeDefined();
    const facts = metric!.facts as Record<string, unknown>;
    expect(facts["longTaskCount"]).toBe(500);
    expect(facts["longTaskMs"]).toBe(549);
    // ONE metric event for the window — not one per entry.
    expect(sinkBatches[0]!.events.filter((e) => e.kind === "client-metric")).toHaveLength(1);
    // The aggregate reset with the window: a second flush holds nothing.
    sinkBatches.length = 0;
    await flushTelemetry();
    expect(sinkBatches.length).toBe(0);
  });
});

describe("run ingest lag — measured at the feed choke point, reported at run end", () => {
  test("the report carries the run, the stream's chat, and the metadata frame's trace", async () => {
    noteRunChat("run-1", "chat-1");
    latchRunTrace("run-1", "trace-r3");
    noteRunFrameApplied("run-1", "model", 3.2);
    noteRunFrameApplied("run-1", "model", 9.7);
    noteRunFrameApplied("run-1", "timeline", 1.1);
    finishRunTelemetry("run-1");
    await flushTelemetry();
    expect(sinkBatches.length).toBe(1);
    const batch = sinkBatches[0]!;
    expect(batch.correlation).toEqual({ runId: "run-1", chatId: "chat-1", traceId: "trace-r3" });
    const [event] = batch.events;
    expect(event?.kind).toBe("client-metric");
    const facts = event?.facts as Record<string, unknown>;
    expect(facts["ingestLagMs"]).toBe(10);
    expect(facts["ingestFrames"]).toBe(3);
  });

  test("a run with no observed frames reports nothing (absence, not a zero)", async () => {
    finishRunTelemetry("run-quiet");
    await flushTelemetry();
    expect(sinkBatches.length).toBe(0);
  });

  test("beyond the per-run metric cap the report is dropped and COUNTED", async () => {
    for (let i = 0; i <= TELEMETRY_RUN_METRIC_CAP; i += 1) {
      noteRunFrameApplied("run-capped", "model", 4);
      finishRunTelemetry("run-capped");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    const metricCount = sinkBatches.flatMap((b) => b.events).filter(
      (e) => (e.facts as Record<string, unknown>)["ingestLagMs"] !== undefined,
    ).length;
    expect(metricCount).toBe(TELEMETRY_RUN_METRIC_CAP);
    // The over-cap report became a counted hole — an empty-buffer flush
    // whose one event IS the count, never a silent loss.
    const hole = sinkBatches
      .flatMap((b) => b.events)
      .find((e) => (e.facts as Record<string, unknown>)["droppedClientEvents"] === 1);
    expect(hole, "the over-cap drop must be stated as a fact").toBeDefined();
  });
});

describe("volume discipline — errors always, batches bounded", () => {
  test("a storm of errors settles into bounded batches — nothing is silently retained", async () => {
    // 100 errors, synchronously — more than five batches' worth. The
    // pressure flush at the batch cap drains as the storm runs, so the
    // buffer never grows past one batch and every event leaves (or is
    // counted) — never silently hoarded.
    for (let i = 0; i < 100; i += 1) {
      captureError({ message: `storm error ${i}` });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushTelemetry();
    const all = sinkBatches.flatMap((b) => b.events);
    expect(all.length).toBe(100);
    for (const batch of sinkBatches) {
      expect(batch.events.length).toBeLessThanOrEqual(TELEMETRY_FLUSH_MAX_EVENTS);
    }
    expect(all.every((e) => e.kind === "client-error")).toBe(true);
    // And an idle flush after the storm finds nothing hoarded.
    sinkBatches.length = 0;
    expect((await flushTelemetry()).sent).toBe(0);
  });

  test("a refused flush counts its events as dropped, and the count travels next time", async () => {
    captureError({ message: "first" });
    sinkAccepts = false;
    await flushTelemetry();
    expect(sinkBatches.length).toBe(1); // the door was called; it refused
    sinkBatches.length = 0;
    captureError({ message: "second" });
    sinkAccepts = true;
    await flushTelemetry();
    // The next accepted batch carries the hole.
    expect(sinkBatches.length).toBe(1);
    expect(sinkBatches[0]!.droppedCount).toBe(1);
  });

  test("events captured under different correlations never share a batch", async () => {
    noteRunChat("run-x", "chat-x");
    noteRunChat("run-y", "chat-y");
    latchRunTrace("run-x", "trace-x");
    noteRunFrameApplied("run-x", "model", 2);
    noteRunFrameApplied("run-y", "model", 3);
    finishRunTelemetry("run-x");
    finishRunTelemetry("run-y");
    captureError({ message: "page-wide" });
    await flushTelemetry();
    const claims = sinkBatches.map((b) => JSON.stringify(b.correlation ?? null));
    expect(new Set(claims).size).toBe(claims.length); // no two batches share a claim
    expect(claims).toContain(JSON.stringify({ runId: "run-x", chatId: "chat-x", traceId: "trace-x" }));
    expect(claims).toContain(JSON.stringify({ runId: "run-y", chatId: "chat-y" }));
    expect(claims).toContain(JSON.stringify(null)); // the page-wide error
  });
});

describe("flush transport — the hidden page goes out through the beacon door", () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  afterEach(() => {
    if (originalNavigator !== undefined) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    }
  });

  test("visibilitychange → hidden flushes via sendBeacon as a PLAIN STRING (no JSON preflight)", async () => {
    // The beacon door resolves its two helper modules lazily; warm them
    // FIRST so the flush completes within microtask ticks (the first cold
    // import is a real async load the dispatcher cannot wait for).
    await import("../../src/data/broker.ts");
    await import("../../src/client-config");
    // The beacon arm must exercise the REAL beacon door — clear the
    // injected sink so flushViaBeacon does not delegate to it.
    installTelemetrySink(null);
    const beaconCalls: { url: string; body: unknown }[] = [];
    Object.defineProperty(globalThis, "navigator", {
      value: { sendBeacon: (url: string, body?: string) => (beaconCalls.push({ url, body }), true) },
      configurable: true,
      writable: true,
    });
    const win = installFakeWindow({ document: { visibilityState: "visible" } });
    attachClientTelemetry();
    captureError({ message: "going away" });
    win.document!.visibilityState = "hidden";
    dispatch(win, "visibilitychange", {});
    // The beacon door resolves its helper modules through dynamic import —
    // a macrotask — so settle on a timer tick, not microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(beaconCalls.length).toBe(1);
    expect(beaconCalls[0]!.url).toBe("/api/b/client.telemetry/ingest");
    // A STRING body — Content-Type text/plain, the simple content type that
    // never forces a CORS preflight a closing page cannot wait for.
    expect(typeof beaconCalls[0]!.body).toBe("string");
    const parsed = JSON.parse(beaconCalls[0]!.body as string) as ClientTelemetryBatch;
    expect(parsed.events[0]?.kind).toBe("client-error");
    // And nothing was hoarded: a second beacon flush has nothing to send.
    expect(await flushViaBeacon()).toBe(true);
    expect(beaconCalls.length).toBe(1);
  });

  test("a beacon that cannot queue counts the drop honestly", async () => {
    installTelemetrySink(null);
    Object.defineProperty(globalThis, "navigator", {
      value: { sendBeacon: () => false },
      configurable: true,
      writable: true,
    });
    captureError({ message: "queue refused" });
    const ok = await flushViaBeacon();
    expect(ok).toBe(false);
    // The refusal was counted: the next accepted batch carries the hole.
    installTelemetrySink(async (batch) => (sinkBatches.push(batch), true));
    captureError({ message: "later" });
    await flushTelemetry();
    expect(sinkBatches[0]!.droppedCount).toBe(1);
  });
});

describe("boot cost — forwarded, not measured", () => {
  test("the boot total lands once as a client-metric", async () => {
    noteBootMs(812);
    noteBootMs(999); // a second completion does not mint a second fact
    await flushTelemetry();
    const boots = sinkBatches.flatMap((b) => b.events).filter(
      (e) => (e.facts as Record<string, unknown>)["bootMs"] !== undefined,
    );
    expect(boots).toHaveLength(1);
    expect((boots[0]!.facts as Record<string, unknown>)["bootMs"]).toBe(812);
  });
});

describe("no-collection rule — the capture never takes page content", () => {
  test("no fact ever carries the URL bar, a query string, or DOM/input values", async () => {
    const win = installFakeWindow();
    attachClientTelemetry();
    dispatch(win, "error", {
      message: "boom",
      filename: "https://evil.example/app.js?password=hunter2&api_key=sk-live-abcdef",
      lineno: 1,
      colno: 1,
    });
    await flushTelemetry();
    const serialized = JSON.stringify(sinkBatches);
    for (const forbidden of ["hunter2", "sk-live-abcdef", "evil.example", "password", "location", "localStorage"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
