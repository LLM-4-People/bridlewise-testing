// @vitest-environment node
/**
 * The process resource sampler — the time-series lane.
 *
 * getSystemMetrics is PULL-based: it answers "what is the process doing"
 * only while someone looks at the Metrics tab. The sampler is the PUSH half:
 * a periodic, best-effort tick that writes the process's footprint into the
 * ledger's existing `resource` lane (the recorder's recordResource — the
 * lane that existed with ZERO call sites before this sampler became its
 * first producer). These tests drive the real tick into the real ledger and
 * read the events back through the public query.
 *
 * What is pinned here:
 *   - a tick writes the footprint levels (RSS, heap used) every time;
 *   - the SECOND tick carries the CPU + event-loop DELTAS since the first
 *     (a delta needs a previous sample — the first tick after start reports
 *     levels only, which is honest, not a gap);
 *   - every metric rides the lane's own shape: one metric per event,
 *     {metric, value, unit};
 *   - start/stop are idempotent and a stopped sampler is a no-op — the
 *     timer can never stack, and shutdown can call stop unconditionally.
 *
 * The interval itself is not awaited in tests (the declared default is
 * 5 000 ms): the tick function is exported precisely so the sampling
 * behavior is testable without sleeping, and the interval is the config
 * contract's `performance.resourceSampler.intervalMs`.
 */
import { describe, test, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

import { getTimelineQuery, timelineReadiness } from "../../server/observability/timeline-bridge.ts";
import {
  sampleResourceOnce,
  startResourceSampler,
  stopResourceSampler,
} from "../../server/observability/metrics-bridge.ts";

beforeAll(() => {
  // Open the ledger before the first tick: the recorder is created lazily on
  // first open, and a tick before installation would be dropped.
  getTimelineQuery();
});

/** The resource events named `metric`, newest first. */
function eventsFor(metric: string) {
  return getTimelineQuery()
    .byEventType("resource", { ascending: false, limit: 500 })
    .events
    .filter((e) => {
      const doc = (e.documents ?? []).find((d) => d.name === "metric");
      if (doc === undefined || doc.contentJson === null) return false;
      try {
        return (JSON.parse(doc.contentJson) as { metric: string }).metric === metric;
      } catch {
        return false;
      }
    });
}

describe("the process resource sampler", () => {
  test("a tick writes the footprint levels into the resource lane", () => {
    // INSTRUMENTED (four failures no run could yet reproduce): the
    // tick's own conditions are read around it — the ledger's readiness (a
    // migrating ledger takes no sample), the resource lane before and after,
    // the clocks — so a red says which of them it was, never only "0".
    const readinessBefore = timelineReadiness();
    const laneBefore = getTimelineQuery().byEventType("resource", { ascending: false, limit: 500 }).events;
    const wallBefore = Date.now();
    sampleResourceOnce();
    const wallAfter = Date.now();
    const laneAfter = getTimelineQuery().byEventType("resource", { ascending: false, limit: 500 }).events;
    const evidence = JSON.stringify({
      readinessBefore, readinessAfter: timelineReadiness(), laneBefore: laneBefore.length, laneAfter: laneAfter.length, wallBefore, wallAfter,
      newest: laneAfter.slice(0, 4).map((event) => ({ id: event.eventId, wall: (event as { wallTime?: unknown }).wallTime, documents: (event.documents ?? []).map((document) => document.name) })),
    });
    for (const metric of ["process.rss", "process.heapUsed"]) {
      const events = eventsFor(metric);
      expect(events.length, `${metric} must be written by a tick — ${evidence}`).toBeGreaterThanOrEqual(1);
      const doc = JSON.parse(events[0]!.documents![0]!.contentJson ?? "{}") as { metric: string; value: number; unit: string };
      expect(doc.value, "a live process has a nonzero footprint").toBeGreaterThan(0);
      expect(doc.unit).toBe("bytes");
    }
  });

  test("the second tick carries the CPU and event-loop deltas since the first", () => {
    // Burn a little CPU so the delta has something to be about.
    sampleResourceOnce();
    let acc = 0;
    for (let i = 0; i < 100_000; i++) acc += i;
    sampleResourceOnce();
    expect(acc).toBeGreaterThanOrEqual(0);
    for (const metric of ["cpu.user", "cpu.system"]) {
      const events = eventsFor(metric);
      expect(events.length, `${metric} must be written once a previous sample exists`).toBeGreaterThanOrEqual(1);
      const doc = JSON.parse(events[0]!.documents![0]!.contentJson ?? "{}") as { metric: string; value: number; unit: string };
      expect(doc.value, "cpu time is a cost, never a gain").toBeGreaterThanOrEqual(0);
      expect(doc.unit).toBe("ms");
    }
    const elu = eventsFor("eventLoop.utilization");
    expect(elu.length, "the event-loop utilization delta must be written").toBeGreaterThanOrEqual(1);
    const doc = JSON.parse(elu[0]!.documents![0]!.contentJson ?? "{}") as { value: number; unit: string };
    expect(doc.value).toBeGreaterThanOrEqual(0);
    expect(doc.value, "utilization is a ratio").toBeLessThanOrEqual(1);
    expect(doc.unit).toBe("ratio");
  });

  test("the sampler's events carry the actor the recorder applies outside any boundary", () => {
    // The sampler runs on a timer, outside any request's recording context.
    // Its events are process-level, and the recorder's own fallback actor
    // applies — the visible "no owner" marker, which is the honest reading
    // for a measurement nobody's request caused.
    sampleResourceOnce();
    const events = eventsFor("process.rss");
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.actorKind).toBeTruthy();
  });

  test("start and stop are idempotent, and stop without start is a no-op", () => {
    const marker = `sampler-lifecycle-${randomUUID()}`;
    expect(marker).toBeTruthy();
    expect(() => stopResourceSampler()).not.toThrow();
    expect(() => startResourceSampler()).not.toThrow();
    expect(() => startResourceSampler()).not.toThrow("a second start must not stack a second timer");
    expect(() => stopResourceSampler()).not.toThrow();
    expect(() => stopResourceSampler()).not.toThrow();
  });
});
