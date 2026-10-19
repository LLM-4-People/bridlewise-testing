/**
 * THE IN-PAGE PROBE — one script, injected before any app code runs, that
 * makes a cockpit boot and every later interaction measurable.
 *
 * Everything here is built on browser primitives (PerformanceObserver,
 * Navigation/Resource Timing, MutationObserver) plus one `fetch` wrapper.
 * No app code is imported, nothing is patched that the app can observe.
 *
 * THREE THINGS PHASE 1 TAUGHT THIS FILE, each of which had already produced
 * a wrong number before it was fixed:
 *
 *  1. A BACKGROUNDED TAB THROTTLES requestAnimationFrame to ~1Hz. Interaction
 *     latencies came back as 1012–1549ms for controls whose DOM settled in
 *     17ms. So `frameClockOk()` exists and every reported latency is gated on
 *     it: a measurement taken behind a throttled frame clock is not a slow
 *     measurement, it is a VOID one, and must be refused rather than reported.
 *
 *  2. `performance.getEntriesByType("resource")` SILENTLY CAPS at 250 entries.
 *     A cockpit boot in dev produces exactly 250, so the tail — every API call
 *     after the module flood — was being dropped without any error. The buffer
 *     is raised in the init script, before the app can fill it.
 *
 *  3. ROOMS NEVER UNMOUNT (RoomHost keeps them alive and flips `visibility`),
 *     so "wait for the room to appear" never fires on reopen. The ack is
 *     `section.room[data-room-active="true"]`, and the boot gate is
 *     `.cockpit[data-revealed="true"]`.
 *
 * SEPARATING WAITING FROM WORKING. The server has no isolation between
 * connections — every DB touch is synchronous on its single event loop — so a
 * stall seen in the browser may be the server blocking rather than the client
 * doing anything wrong. A number that cannot tell those apart is not evidence.
 * `boot()` therefore reports, over the same window: the UNION of intervals
 * with at least one request in flight (network-occupied), the summed long-task
 * time (client-occupied), and the overlap. Attribution is then a fact about
 * the timeline rather than an opinion.
 *
 * @test-only — never imported by the runtime bundle.
 */

/** Raised well past the 250-entry default (see note 2 above). */
const RESOURCE_BUFFER = 1000;

/**
 * The script injected via `addInitScript` / `initScript` BEFORE any app code.
 * Written as a plain string so it can be handed to Playwright and to the
 * chrome-devtools MCP identically — one probe, two drivers, no drift.
 */
export const INIT_PROBE = `
(() => {
  const w = window;
  try { performance.setResourceTimingBufferSize(${RESOURCE_BUFFER}); } catch (e) {}
  const P = {
    longTasks: [], shifts: 0, shiftValue: 0, fetches: [], revealAt: null,
    firstPaint: null, errors: [],
  };
  w.__probe = P;

  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) P.longTasks.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) {}

  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (!e.hadRecentInput) { P.shifts += 1; P.shiftValue += e.value; }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) {}

  // Wrap fetch to get exact in-flight windows. Resource Timing alone cannot
  // say when the APP asked, only when the network moved; the gap between
  // those two is precisely the serial-chain evidence we are after.
  const origFetch = w.fetch;
  w.fetch = function (...args) {
    const input = args[0];
    const url = String(input && input.url ? input.url : input).replace(/^https?:\\/\\/[^/]+/, '');
    const rec = { url, start: performance.now(), end: null, status: null, bytes: null };
    P.fetches.push(rec);
    return origFetch.apply(this, args).then(
      (res) => {
        rec.end = performance.now();
        rec.status = res.status;
        try {
          const c = res.clone();
          c.arrayBuffer().then((b) => { rec.bytes = b.byteLength; }, () => {});
        } catch (e) {}
        return res;
      },
      (err) => { rec.end = performance.now(); rec.status = -1; rec.error = String(err); throw err; },
    );
  };

  // The reveal gate (§10.3 one-reveal law) — the honest "usable" moment.
  const markReveal = () => {
    if (P.revealAt === null && document.querySelector('.cockpit[data-revealed="true"]')) {
      P.revealAt = performance.now();
      return true;
    }
    return false;
  };
  const start = () => {
    if (markReveal()) return;
    const mo = new MutationObserver(() => { if (markReveal()) mo.disconnect(); });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  w.addEventListener('error', (e) => P.errors.push(String(e.message)));
})();
`;

/**
 * Union length of a set of intervals, in ms. Two requests overlapping for
 * 300ms occupy 300ms of wall time, not 600 — summing durations would
 * overstate network time exactly where concurrency is highest, which is the
 * one place the conclusion actually turns on it.
 */
export function unionMs(
  intervals: ReadonlyArray<{ start: number; end: number }>,
): number {
  const live = intervals
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = Number.NaN;
  let curEnd = Number.NaN;
  for (const i of live) {
    if (Number.isNaN(curStart)) {
      curStart = i.start; curEnd = i.end; continue;
    }
    if (i.start > curEnd) { total += curEnd - curStart; curStart = i.start; curEnd = i.end; }
    else if (i.end > curEnd) curEnd = i.end;
  }
  if (!Number.isNaN(curStart)) total += curEnd - curStart;
  return total;
}

/**
 * Classify a chain of requests as SERIAL or overlapped. A leg is "serial
 * after" its predecessor when it starts at or after the predecessor ended:
 * the client could not have known to ask until the answer arrived.
 */
export function serialLegs(
  calls: ReadonlyArray<{ url: string; start: number; end: number }>,
): ReadonlyArray<{ from: string; to: string; gapMs: number; serial: boolean }> {
  const out: Array<{ from: string; to: string; gapMs: number; serial: boolean }> = [];
  for (let i = 1; i < calls.length; i += 1) {
    const prev = calls[i - 1]!;
    const cur = calls[i]!;
    out.push({
      from: prev.url,
      to: cur.url,
      gapMs: Math.round((cur.start - prev.end) * 100) / 100,
      serial: cur.start >= prev.end,
    });
  }
  return out;
}

/** The latency bands this product is judged against (DESIGN-COCKPIT-V2 §1.5,
 * mirrored from bench/lib/stats.ts so browser and backend verdicts agree). */
export const BUDGET = { FRAME_MS: 16, ACK_MS: 100, VIEW_MS: 200, FLOW_MS: 1000 } as const;

export function band(ms: number): string {
  if (!Number.isFinite(ms)) return "?";
  if (ms <= BUDGET.FRAME_MS) return "FRAME";
  if (ms <= BUDGET.ACK_MS) return "ACK";
  if (ms <= BUDGET.VIEW_MS) return "VIEW";
  if (ms <= BUDGET.FLOW_MS) return "FLOW";
  return "BROKEN";
}
