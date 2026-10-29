/**
 * Performance harness — Playwright + Chrome DevTools Protocol metric
 * collection for the web UI.
 *
 * Design (per the "Quality wins over time and effort" rule): built ENTIRELY
 * on built-in mechanisms — no custom machinery, no new runtime deps.
 *   • Web vitals (LCP, CLS, FCP, TTFB) → the browser's PerformanceObserver
 *     + Navigation Timing API, read back via `page.evaluate`.
 *   • Long tasks (TBT proxy) → PerformanceObserver `longtask` entries.
 *   • Interaction latency (INP proxy) → PerformanceObserver `event` entries
 *     (the worst event-duration over the page lifetime).
 *   • DOM / layout / style / script duration → CDP `Performance.getMetrics`
 *     (one round-trip, no tracing overhead).
 *   • JS heap → `performance.memory` (Chromium-only, available in the test
 *     browser).
 *   • Network → `page.on("response")` for every `/api/` call (method, url,
 *     status, bytes, response ms).
 *   • Interaction latency (click→render) → `performance.now()` bracketing a
 *     Playwright click + `waitForSelector` (perceived latency, includes the
 *     Svelte re-render).
 *
 * The harness is one class (`PerfHarness`) wrapping a Playwright `Page` +
 * its CDP session. A profile is a sequence of named measurements that share
 * a single network observer so the full request waterfall is captured once.
 *
 * @test-only — not shipped to the runtime bundle.
 */
import type { DbClient } from "../../../server/db/client.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { Page, CDPSession, Response, Request as PlaywrightRequest } from "@playwright/test";

/** One web-vitals snapshot collected from the page via PerformanceObserver.
 *
 * NOT-MEASURED IS NaN, NEVER 0 — the one shape for "this was not measured"
 * is NaN in memory (JSON serializes it as `null` on disk), and every reader
 * refuses it by name rather than judging a budget against it. A measured
 * zero is a real answer ("the observer was live and saw nothing"), and the
 * per-field rules below state exactly when 0 is honest:
 *
 *   - `lcp` / `fcp` / `ttfb` — NaN when no entry was observed (the metric
 *     never happened in this window). These are load-time paint timings;
 *     0 is not a reachable honest value.
 *   - `cls` / `clsEntries` — 0 is honest ONLY when the layout-shift
 *     observer was live (shifts can occur with nobody interacting, so an
 *     empty window is a real measured answer). When the observer never
 *     installed, both are NaN — "observer missing", not "measured none".
 *   - `longTaskTotalMs` / `longTaskCount` / `longTaskWorstMs` — same rule
 *     as CLS: 0 with a live observer means "measured, none occurred";
 *     NaN means the long-task observer was absent, so nothing was watched.
 *   - `inpMs` — NaN whenever `eventCount` is 0. Input events cannot occur
 *     unless someone performs them, so a window with no interactions has
 *     NO INP to report (the metric itself is unavailable then — the same
 *     honesty rule web.dev states for field INP), and reporting 0 would
 *     read as "interactions were instant". `eventCount` 0 with a live
 *     observer is a real measured answer about the COUNT, but it vacates
 *     the latency: no observations, no latency, never zero. */
export type WebVitals = {
  /** Largest contentful paint (ms since navigation start). NaN if none. */
  readonly lcp: number;
  /** First contentful paint (ms). NaN if none. */
  readonly fcp: number;
  /** Time to first byte (ms, from Navigation Timing). NaN if none. */
  readonly ttfb: number;
  /** Cumulative layout shift (unitless, summed over the window). NaN when
   * the layout-shift observer never installed; 0 = measured, none occurred. */
  readonly cls: number;
  /** Layout-shift entries observed. NaN when the observer never installed. */
  readonly clsEntries: number;
  /** Total long-task time (ms) — a TBT proxy. NaN when the long-task
   * observer never installed; 0 = measured, none occurred. */
  readonly longTaskTotalMs: number;
  /** Long tasks (>50ms) observed. NaN when the observer never installed. */
  readonly longTaskCount: number;
  /** Worst single long-task duration (ms). NaN when the observer never
   * installed; 0 = measured, none occurred. */
  readonly longTaskWorstMs: number;
  /** Worst interaction event duration (ms) — an INP proxy. NaN whenever
   * `eventCount` is 0 (no interactions occurred in the window, so the
   * latency was not measured; never 0-as-not-measured). */
  readonly inpMs: number;
  /** Interaction `event` entries observed. NaN when the event observer
   * never installed; 0 with a live observer = measured, none occurred. */
  readonly eventCount: number;
};

/** CDP `Performance.getMetrics` projection (the subset we use). */
export type CdpMetrics = {
  readonly nodes: number;
  readonly documents: number;
  readonly frames: number;
  readonly jsEventListeners: number;
  readonly layoutCount: number;
  readonly recalcStyleCount: number;
  readonly layoutDurationMs: number;
  readonly recalcStyleDurationMs: number;
  readonly scriptDurationMs: number;
  readonly taskDurationMs: number;
  readonly jsHeapUsedMb: number;
  readonly jsHeapTotalMb: number;
};

/** One captured API network call. */
export type ApiCall = {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  /** Encoded body + HTTP header size; NaN until completion is measured. */
  readonly bytes: number;
  readonly responseMs: number;
  /** Native startTime is Unix epoch ms; other coordinates are offsets from
   * it, with -1 for stages the browser has not observed. */
  readonly timing: Readonly<ReturnType<PlaywrightRequest["timing"]>>;
  readonly traceId: string | null;
  /** Node callback observation time (Unix epoch ms), not browser timing. */
  readonly observedAt: number;
  /** Unknown unless this request's cache provenance was observed. */
  readonly fromCache: boolean | null;
  readonly compressed: boolean;
};

/** A memory snapshot (JS heap + DOM counts at one point in time). */
export type MemorySnapshot = {
  readonly label: string;
  readonly jsHeapUsedMb: number;
  readonly jsHeapTotalMb: number;
  readonly domNodes: number;
  readonly domDepth: number;
  readonly eventListeners: number;
};

/** A latency measurement — the duration of one real interaction, measured
 * through to its perceived settle (click → acknowledged state rendered;
 * keystroke → the reactive frame presented). `durationMs` is NaN when
 * nothing was measured; `ok: false` names the refusal in the note. */
export type LatencyMeasurement = {
  readonly kind: "latency";
  readonly name: string;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly note: string;
};

/** A long-task census over one scroll window, with the proof the scroll
 * itself ran. There is no `durationMs` here on purpose: the reading is a
 * census (total/count/worst of >50ms tasks during the scroll), not an
 * interaction duration, and `scrolledPixels` is the scroll's own travel
 * read back from the element — 0 means the probe measured nothing and must
 * refuse, never pass. */
export type ScrollLongTaskReading = {
  readonly kind: "scroll-long-task";
  readonly name: string;
  readonly longTaskTotalMs: number;
  readonly longTaskCount: number;
  readonly longTaskWorstMs: number;
  /** The scroll surface's own scrollTop delta over the window, px. NaN
   * when the surface could not be resolved at all; 0 when the surface
   * existed but never moved (a refusal — the probe measured nothing). */
  readonly scrolledPixels: number;
  readonly ok: boolean;
  readonly note: string;
};

/** The typing measurement's own extra fields: the page's rendered-frame
 * period measured over the same keystrokes (the gate's settle floor) and
 * the keystroke count. */
export type TypingMeasurement = LatencyMeasurement & {
  readonly framePeriodMs: number;
  readonly keys: number;
};

/** One named interaction measurement — a latency or a scroll census, told
 * apart by `kind` so a census row can never be read through a latency's
 * fields (the old shape laundered long-task totals through `durationMs`). */
export type InteractionMeasurement = LatencyMeasurement | ScrollLongTaskReading;

/** The census fields shared by every scroll-window long-task reading in the
 * report (the interaction rows and the real-data phases alike) — honest
 * names for exactly what was counted, plus the scroll's own travel. */
export type ScrollCensus = {
  readonly longTaskTotalMs: number;
  readonly longTaskCount: number;
  readonly longTaskWorstMs: number;
  readonly scrolledPixels: number;
  readonly ok: boolean;
  readonly note: string;
};

/** One interactive element discovered from the DOM (deny-by-default: the
 * scan finds every clickable/toggleable/input element on the page; a newly
 * added button is auto-profiled — no hardcoded list). The `tag` + `idx`
 * identify the element for re-location via `page.locator(tag).nth(idx)`
 * (Playwright's positional locator — more reliable than a generated CSS
 * selector because `nth-of-type` is relative to the parent, not the
 * document). */
export type InteractiveElement = {
  readonly role: string;
  readonly label: string;
  readonly tag: string;
  readonly idx: number;
  /** A run-unique stamp written ONTO the node at discovery; clicks locate
   *  the node by it, never by position — a click that opens a menu inserts
   *  buttons mid-list and shifts every later tag-index (measured
   *  2026-08-30: an aimed read-only control's click landed on "sign out",
   *  ended the session, and every later reload landed on the auth gate). */
  readonly stamp: string;
  readonly visible: boolean;
};

/** The measured latency of one interactive element (click → next frame). */
export type InteractiveProfile = {
  readonly role: string;
  readonly label: string;
  readonly tag: string;
  readonly clickMs: number;
  /** The worst long task observed during the click's settle window, ms —
   * NaN when the census was not live. The jank judgment belongs to the
   * regression gate, not the probe. */
  readonly longTaskWorstMs: number;
  /** The bracket's own verdict: the click dispatched, the next frame
   * observed, and the census live. A refusal names itself in the note. */
  readonly ok: boolean;
  readonly note: string;
};

/** One API route discovered by scanning the server route source. The path
 * keeps its `:param` placeholders; the `profiledPath` is the resolved path
 * with sample values substituted. A route is `profiled: false` when it is
 * mutating (POST/PUT/PATCH/DELETE) and the harness does not auto-call it. */
export type DiscoveredRoute = {
  readonly method: string;
  readonly path: string;
  readonly sourceFile: string;
  readonly profiled: boolean;
  readonly reason: string;
};

/** The measured response of one API route call (status, latency, bytes). */
export type RouteProfile = {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** The measured (steady-state) call — what the API budget judges. */
  readonly responseMs: number;
  /** The un-measured warm-up call: the difference from responseMs is the
   * one-time cost the route pays on first touch (module import, seeding,
   * first query). Recorded so a budget claim can name which it hit. */
  readonly warmupMs: number;
  readonly bytes: number;
  readonly ok: boolean;
  readonly note: string;
};

/** One viewport configuration profiled for responsiveness (desktop/tablet/mobile). */
export type ViewportProfile = {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly lcp: number;
  readonly cls: number;
  readonly longTaskWorstMs: number;
  readonly domNodes: number;
  readonly ok: boolean;
};

/**
 * The tree the profile measured. The regression gate binds freshness to
 * THIS, never to wall-clock age: a report is fresh iff the code the profile
 * MEASURED is still the code at HEAD. The measure of that is
 * `measuredSurfaceHash` — a content hash over the paths the dev server
 * serves and executes (the shared `readMeasuredSurfaceHash` owner) — not the
 * HEAD sha itself: a commit that moves HEAD without touching the measured
 * surface (a merge-door commit over `scripts/`/`tests/`/docs) leaves every
 * measured byte alone, and staling the report over it is a recurring cost
 * that carries no signal. `headSha` is read from the filesystem (the shared
 * `readRepositoryHeadSha` owner) and recorded for PROVENANCE — the report
 * still says which commit it ran against; `dirty` records whether the
 * working tree carried uncommitted changes, so a profile taken over a dirty
 * tree is visibly labelled as measuring more than the committed content
 * names. `measuredSurfaceHash` is REQUIRED alongside: a report without it
 * predates the surface-bound format, and the gate refuses it outright
 * (deny-by-default — "is this report about this code" is unanswerable
 * without the content identity of what was measured).
 */
export type TreeIdentity = {
  readonly headSha: string;
  readonly measuredSurfaceHash: string;
  readonly dirty: boolean;
};

/** The full profile report written to disk + read by the regression test. */
export type ProfileReport = {
  readonly generatedAt: string;
  /** REQUIRED — a report with no tree identity is a legacy artifact the
   * regression gate refuses outright (deny-by-default): without the sha it
   * was measured against, "fresh" is unanswerable and any verdict it feeds
   * is a guess. */
  readonly treeIdentity: TreeIdentity;
  readonly url: string;
  readonly userAgent: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly pageLoad: WebVitals;
  /**
   * Evidence that the measured page-load numbers followed ONE un-measured
   * warm-up load — the cold-vite compile is paid BEFORE the measured load.
   *
   * THE FALSE REDS THIS FIELD ENDS (measured across three rounds): the
   * first profile run after a dev-server restart reds phase 2's LCP
   * because cold vite compiles the shell on the first navigation — the
   * SAME tree measured 1988–4724ms cold against ~600ms warm, so the
   * budget was being asserted against the compiler, not the app. The
   * honest shape is one un-measured load (which absorbs the compilation)
   * and THEN the measured loads — the warm-up must not weaken the arm:
   * the budget still asserts on the measured load's numbers, and this
   * field is how the regression gate can tell a warm-number report from
   * one whose numbers might be the compiler's.
   *
   * `wallClockMs` is the warm-up load's own duration (un-measured LCP —
   * its vitals are deliberately never read); it exists so a report whose
   * "warm-up" loaded nothing (0ms) is refused rather than believed.
   */
  readonly pageLoadWarmUp: { readonly wallClockMs: number };
  readonly cdpAtLoad: CdpMetrics;
  readonly network: readonly ApiCall[];
  readonly networkSummary: {
    readonly totalCalls: number;
    readonly totalBytes: number;
    readonly compressedCount: number;
    readonly cachedCount: number | null;
    readonly slowest: { readonly url: string; readonly responseMs: number } | null;
    readonly avgResponseMs: number;
    readonly maxResponseMs: number;
  };
  readonly tabs: ReadonlyArray<{
    readonly name: string;
    readonly switchMs: number;
    readonly domNodes: number;
    readonly longTaskTotalMs: number;
    readonly ok: boolean;
    readonly note: string;
  }>;
  readonly interactions: readonly InteractionMeasurement[];
  readonly interactiveElements: readonly InteractiveProfile[];
  readonly discoveredRoutes: readonly DiscoveredRoute[];
  readonly routeProfiles: readonly RouteProfile[];
  readonly routeSummary: {
    readonly totalDiscovered: number;
    readonly totalProfiled: number;
    readonly maxResponseMs: number;
    readonly slowest: { readonly method: string; readonly path: string; readonly responseMs: number } | null;
    /** Isolation evidence for the route timings: the page's URL when route
     * profiling ran + the number of browser-driven API calls captured up to
     * that point. `"about:blank"` + `0` prove the measurement ran BEFORE the
     * browser session started — a route timed during the session measures
     * the session's contention, not the route (measured ~3000x inflation:
     * `GET /api/health` reported 8562ms in-session vs ~2ms by a direct
     * call). The regression gate asserts both values. */
    readonly isolation: {
      readonly pageUrl: string;
      readonly browserApiCallsAtMeasure: number;
    };
  };
  readonly realData: {
    readonly longChat: {
      readonly messageCount: number;
      readonly loadedMessages: number;
      readonly wireMessages: number;
      readonly populationMatches: boolean;
      readonly visibleConversation: boolean;
      readonly inputScrollPixels: number;
      readonly renderMs: number;
      readonly domNodes: number;
      /** Long-task census over the seeded chat's own scroll window (the
       * flow scrolled by the phase), with the scroll's travel read back. */
      readonly scroll: ScrollCensus;
      readonly ok: boolean;
    };
    readonly manyProjects: {
      readonly projectCount: number;
      readonly completedProjects: number;
      readonly loadedProjects: number;
      readonly chatCount: number;
      readonly retriedProjectIds: readonly string[];
      readonly mountedCaps: number;
      readonly mountedReels: number;
      readonly populationMatches: boolean;
      readonly completionMs: number;
      readonly renderMs: number;
      readonly ok: boolean;
      /** The switch feed's OWN chats reads over the phase window,
       * issuer-attributed by fetch-creation stack (the boot's one
       * restoreKeptConversation read is not the feed's, and an inclusive
       * counter once read 3 against the feed's cap of 2 — a breach the
       * stacks disproved). Complete real responses are counted separately. */
      readonly chatsFetches: number;
      /** The feed's peak IN-FLIGHT overlap — the product's real
       * concurrency guarantee; the regression gate asserts this never
       * exceeds FEED_CONCURRENCY. */
      readonly maxChatsInFlight: number;
    };
  };
  readonly viewports: readonly ViewportProfile[];
  readonly memory: readonly MemorySnapshot[];
  readonly longSession: {
    readonly heapGrowthMb: number;
    readonly domNodeGrowth: number;
  };
};

/** The injected web-vitals collector. Runs in the page; stores results on
 * `window.__perf` so the harness can read them back. Pure observers, no
 * mutation of app state.
 *
 * LIVENESS IS THE TRUTH SOURCE FOR ZERO. The accumulators seed at 0 (they
 * must — `NaN += value` stays NaN forever), so a 0 in `window.__perf` is
 * ambiguous between "the observer was live and saw nothing" and "the
 * observer never installed". Each successful `.observe()` therefore sets a
 * flag in `window.__perf.obs`; `readWebVitals` refuses a field whose
 * observer flag is absent (NaN — not measured) and trusts its 0 only when
 * the flag says someone was watching.
 *
 * The event observer sets `durationThreshold: 16` — the Event Timing API's
 * documented minimum. Without it the default threshold is 104ms, so every
 * ordinary (<104ms) keystroke and click is invisible to the observer and
 * `eventCount` is structurally pinned at 0 (the same value web-vitals'
 * reference implementation uses). */
const WEB_VITALS_INJECT = `
window.__perf = window.__perf || { lcp: NaN, fcp: NaN, cls: 0, clsEntries: 0, longTaskTotalMs: 0, longTaskCount: 0, longTaskWorstMs: 0, inpMs: 0, eventCount: 0, ttfb: NaN };
window.__perf.obs = window.__perf.obs || {};
(function () {
  try {
    var nav = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
    if (nav) window.__perf.ttfb = nav.responseStart - nav.requestStart;
  } catch (e) {}
  try {
    var paints = performance.getEntriesByType("paint") || [];
    for (var i = 0; i < paints.length; i++) {
      if (paints[i].name === "first-contentful-paint") window.__perf.fcp = paints[i].startTime;
      if (paints[i].name === "first-paint" && isNaN(window.__perf.fcp)) window.__perf.fcp = paints[i].startTime;
    }
  } catch (e) {}
  try {
    new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        window.__perf.lcp = e.startTime;
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });
    window.__perf.obs.lcp = true;
  } catch (e) {}
  try {
    new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].hadRecentInput) {
          window.__perf.cls += entries[i].value;
          window.__perf.clsEntries += 1;
        }
      }
    }).observe({ type: "layout-shift", buffered: true });
    window.__perf.obs.layoutShift = true;
  } catch (e) {}
  try {
    new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        var d = entries[i].duration;
        window.__perf.longTaskTotalMs += d;
        window.__perf.longTaskCount += 1;
        if (d > window.__perf.longTaskWorstMs) window.__perf.longTaskWorstMs = d;
      }
    }).observe({ type: "longtask", buffered: true });
    window.__perf.obs.longTask = true;
  } catch (e) {}
  try {
    new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        var d = entries[i].duration;
        window.__perf.eventCount += 1;
        if (d > window.__perf.inpMs) window.__perf.inpMs = d;
      }
    }).observe({ type: "event", buffered: true, durationThreshold: 16 });
    window.__perf.obs.event = true;
  } catch (e) {}
})();
`;

function round(v: number, digits = 2): number {
  if (!Number.isFinite(v)) return v;
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

/** Round a number to a fixed precision. Shared with the profile spec so the
 * two files do not duplicate the helper. */
export { round };

export class PerfHarness {
  readonly page: Page;
  private cdpPromise: Promise<CDPSession> | null = null;
  private readonly apiCalls: ApiCall[] = [];
  private readonly apiCallPositions = new WeakMap<PlaywrightRequest, number>();
  private readonly pendingNetworkSizes = new Set<Promise<void>>();
  private networkCaptureFailure: { error: unknown } | undefined;
  private finalizedCalls: ApiCall[] | null = null;
  private readonly memSnapshots: MemorySnapshot[] = [];
  /** The feed-chats init script is added once per page (addInitScript is
   * not removable); the flag re-arms it per phase. */
  private feedTrackerInstalled = false;

  constructor(page: Page) {
    this.page = page;
    // Headers establish a row; completion updates that same request's row.
    // At response, responseEnd is still -1. Request identity also keeps
    // repeated URLs separate across reloads and Resource Timing eviction.
    page.on("response", (res: Response) => this.captureResponse(res));
    page.on("requestfinished", (request: PlaywrightRequest) => {
      const response = request.existingResponse();
      if (response === null) return;
      const index = this.captureResponse(response);
      if (index === undefined) return;
      // Request handles are bounded by Playwright. Acquire their native size
      // now, while this completed request still exists; retain only numbers.
      const pending = request.sizes().then(sizes => {
        this.apiCalls[index] = { ...this.apiCalls[index]!, bytes: sizes.responseBodySize + sizes.responseHeadersSize };
      }).catch(error => { this.networkCaptureFailure ??= { error }; });
      this.pendingNetworkSizes.add(pending);
      void pending.finally(() => this.pendingNetworkSizes.delete(pending));
    });
  }

  /** Lazily create the CDP session (Playwright's `newCDPSession` is async).
   * Cached so subsequent reads reuse the one session. */
  private async cdp(): Promise<CDPSession> {
    if (this.cdpPromise === null) {
      this.cdpPromise = this.page.context().newCDPSession(this.page).then(async (session) => {
        await session.send("Performance.enable");
        return session;
      });
    }
    return this.cdpPromise;
  }

  /** Eagerly create + enable the CDP Performance domain BEFORE the page
   * navigates, so load-time script/layout durations are captured from the
   * start. Call once after constructing the harness, before `page.goto`. */
  async initCdpEarly(): Promise<void> {
    await this.cdp();
  }

  /** Initialise the in-page observers. Call once after navigation, before
   * any measurements. Safe to re-call (the observers reset `window.__perf`
   * only if it is absent). */
  async injectObservers(): Promise<void> {
    await this.page.evaluate(WEB_VITALS_INJECT);
  }

  /** Reset the page-side counters (e.g. before a focused interaction). Keeps
   * LCP/FCP/TTFB (those are load-time metrics) but clears the streaming
   * counters (CLS, long tasks, INP). */
  async resetCounters(): Promise<void> {
    await this.page.evaluate(() => {
      const p = (window as { __perf?: Record<string, number> }).__perf;
      if (p !== undefined) {
        p.cls = 0;
        p.clsEntries = 0;
        p.longTaskTotalMs = 0;
        p.longTaskCount = 0;
        p.longTaskWorstMs = 0;
        p.inpMs = 0;
        p.eventCount = 0;
      }
    });
  }

  /** Read the web-vitals counters accumulated in the page. Each field is
   * honest about measured-zero vs not-measured per the `WebVitals` type's
   * rules: a field whose observer never installed reads NaN, INP reads NaN
   * when no interactions occurred, and a 0 is trusted only when the
   * observer was live. */
  async readWebVitals(): Promise<WebVitals> {
    const v = await this.page.evaluate(() => {
      const p = (window as { __perf?: Record<string, unknown> }).__perf;
      if (p === undefined) return null;
      const obs = (p.obs ?? {}) as Record<string, boolean>;
      const num = (key: string, live: boolean): number =>
        live && typeof p[key] === "number" ? (p[key] as number) : NaN;
      return {
        lcp: num("lcp", obs.lcp === true),
        fcp: num("fcp", true),
        ttfb: num("ttfb", true),
        cls: num("cls", obs.layoutShift === true),
        clsEntries: num("clsEntries", obs.layoutShift === true),
        longTaskTotalMs: num("longTaskTotalMs", obs.longTask === true),
        longTaskCount: num("longTaskCount", obs.longTask === true),
        longTaskWorstMs: num("longTaskWorstMs", obs.longTask === true),
        eventCount: num("eventCount", obs.event === true),
        inpMs: num("inpMs", obs.event === true),
      };
    });
    if (v === null) {
      // No collector was ever injected in this document — NOTHING was
      // measured, and the honest answer is NaN across the board, never a
      // row of zeros a budget cannot fail.
      return {
        lcp: NaN, fcp: NaN, ttfb: NaN, cls: NaN, clsEntries: NaN,
        longTaskTotalMs: NaN, longTaskCount: NaN, longTaskWorstMs: NaN,
        inpMs: NaN, eventCount: NaN,
      };
    }
    // INP: no interactions in the window means the latency was NOT measured
    // (the metric is unavailable then, per its own field semantics) — NaN,
    // never 0-as-not-measured.
    const inpMs = v.eventCount > 0 ? v.inpMs : NaN;
    return {
      lcp: round(v.lcp), fcp: round(v.fcp), ttfb: round(v.ttfb),
      cls: round(v.cls, 4), clsEntries: v.clsEntries,
      longTaskTotalMs: round(v.longTaskTotalMs), longTaskCount: v.longTaskCount,
      longTaskWorstMs: round(v.longTaskWorstMs), inpMs: round(inpMs),
      eventCount: v.eventCount,
    };
  }

  /** Read CDP Performance metrics (DOM nodes, layout/style/script duration,
   * JS heap). One round-trip — no tracing overhead. */
  async readCdpMetrics(): Promise<CdpMetrics> {
    const cdp = await this.cdp();
    const r = await cdp.send("Performance.getMetrics");
    const m = new Map<string, number>();
    for (const entry of r.metrics ?? []) {
      m.set(entry.name, entry.value);
    }
    return {
      nodes: m.get("Nodes") ?? 0,
      documents: m.get("Documents") ?? 0,
      frames: m.get("Frames") ?? 0,
      jsEventListeners: m.get("JSEventListeners") ?? 0,
      layoutCount: m.get("LayoutCount") ?? 0,
      recalcStyleCount: m.get("RecalcStyleCount") ?? 0,
      layoutDurationMs: round(m.get("LayoutDuration") ?? 0),
      recalcStyleDurationMs: round(m.get("RecalcStyleDuration") ?? 0),
      scriptDurationMs: round(m.get("ScriptDuration") ?? 0),
      taskDurationMs: round(m.get("TaskDuration") ?? 0),
      jsHeapUsedMb: round((m.get("JSHeapUsedSize") ?? 0) / 1048576, 2),
      jsHeapTotalMb: round((m.get("JSHeapTotalSize") ?? 0) / 1048576, 2),
    };
  }

  /** Snapshot the JS heap + DOM node count + tree depth at one moment. */
  async snapshotMemory(label: string): Promise<MemorySnapshot> {
    const r = await this.page.evaluate(() => {
      const mem = (performance as unknown as {
        memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
      }).memory;
      // DOM tree depth: walk up from the deepest element we can find by
      // querying a broad selector + measuring parent chains. A full tree
      // walk is O(n); this is a bounded heuristic (max depth of body's
      // first 200 descendants) that is cheap + good enough for leak
      // detection (the question is "does depth grow", not "exact depth").
      let depth = 0;
      const all = document.body ? document.body.querySelectorAll("*") : document.querySelectorAll("*");
      const sample = Math.min(all.length, 400);
      for (let i = 0; i < sample; i += 7) {
        let d = 0;
        let n: Node | null = all[i] ?? null;
        while (n !== null) { d += 1; n = n.parentNode; }
        if (d > depth) depth = d;
      }
      const listenerCount = (window as { __listenerEstimate?: number }).__listenerEstimate ?? 0;
      return {
        jsHeapUsedMb: mem ? Math.round(mem.usedJSHeapSize / 1048576 * 100) / 100 : 0,
        jsHeapTotalMb: mem ? Math.round(mem.totalJSHeapSize / 1048576 * 100) / 100 : 0,
        domNodes: document.querySelectorAll("*").length,
        domDepth: depth,
        eventListeners: listenerCount,
      };
    });
    const snap: MemorySnapshot = { label, ...r };
    this.memSnapshots.push(snap);
    return snap;
  }

  /** Measure the perceived latency of a click→render interaction.
   * `clickSelector` is the element to click; `waitSelector` is an element
   * that proves the new state rendered. `waitState` says which visibility
   * of the target acknowledges the interaction ("visible" — the target
   * must APPEAR; "hidden" — the target must go away), so a close gesture
   * can be bracketed by the state it actually produces instead of by a
   * target that pre-exists the click (a pre-existing target closes the
   * bracket on the dispatch and measures nothing about the render).
   * Returns the elapsed ms from just-before the click to the acknowledged
   * state; NaN + ok:false names the failure when the bracket never closes
   * honestly. */
  async measureClick(
    clickSelector: string,
    waitSelector: string,
    name: string,
    opts?: { waitState?: "visible" | "hidden" },
  ): Promise<LatencyMeasurement> {
    const waitState = opts?.waitState ?? "visible";
    // THE BRACKET MUST PROVE A RENDER. A wait target that is ALREADY in
    // the awaited state before the click closes on the dispatch itself —
    // the number would be playwright's click, not the user's latency. The
    // pre-state is read back and the refusal names it, so an inert target
    // can never masquerade as a measured interaction.
    const targetVisibleBefore = await this.page.locator(waitSelector).first().isVisible().catch(() => false);
    const alreadyInAwaitedState = waitState === "visible" ? targetVisibleBefore : !targetVisibleBefore;
    if (alreadyInAwaitedState) {
      return {
        kind: "latency", name, durationMs: NaN, ok: false,
        note:
          `the wait target (${waitSelector}) was already ${waitState} before the click — ` +
          "the bracket would close on the dispatch, not a render, so nothing was measured",
      };
    }
    try {
      await this.page.evaluate(() => {
        (window as { __t0?: number }).__t0 = performance.now();
      });
      const el = this.page.locator(clickSelector).first();
      await el.click({ timeout: 5000 });
      await this.page.waitForSelector(waitSelector, { state: waitState, timeout: 8000 });
      const dur = await this.page.evaluate(() => performance.now() - ((window as { __t0?: number }).__t0 ?? 0));
      return {
        kind: "latency", name, durationMs: round(dur), ok: true,
        note: `click → ${waitSelector} ${waitState} (the acknowledged state's own render)`,
      };
    } catch (err) {
      return { kind: "latency", name, durationMs: NaN, ok: false, note: String((err as Error)?.message ?? err) };
    }
  }

  /** Measure the latency of opening a cockpit room via its chord grip.
   * `roomId` is the room's id (e.g. "switch"); the grip carries
   * `data-chord-target="<id>"` and the acknowledgement is the room's own
   * `section.room[data-room-active="true"]` with its aria-label. Rooms are
   * kept alive and flipped, never unmounted — a second open of the same
   * room measures the warm path; the caller decides which pass it is
   * measuring. Returns open ms + DOM node count with the room active. A
   * refused open carries NaN for every unmeasured number and names the
   * failure in the note — never a zero that a budget cannot fail. */
  async measureRoomOpen(roomId: string): Promise<{
    name: string;
    switchMs: number;
    domNodes: number;
    longTaskTotalMs: number;
    ok: boolean;
    note: string;
  }> {
    const ack = `section.room[data-room-active="true"][aria-label="${roomId} room"]`;
    try {
      await this.resetCounters();
      await this.page.evaluate(() => {
        (window as { __t0?: number }).__t0 = performance.now();
      });
      await this.page.locator(`[data-chord-target="${roomId}"]`).first().click({ timeout: 5000 });
      await this.page.waitForSelector(ack, { state: "visible", timeout: 8000 });
      await this.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
      const dur = await this.page.evaluate(() => performance.now() - ((window as { __t0?: number }).__t0 ?? 0));
      const domNodes = await this.page.evaluate(() => document.querySelectorAll("*").length);
      const vitals = await this.readWebVitals();
      return {
        name: roomId, switchMs: round(dur), domNodes, longTaskTotalMs: vitals.longTaskTotalMs,
        ok: true, note: "grip click → room-active acknowledgement + one rAF",
      };
    } catch (err) {
      return {
        name: roomId, switchMs: NaN, domNodes: NaN, longTaskTotalMs: NaN,
        ok: false, note: String((err as Error)?.message ?? err).slice(0, 120),
      };
    }
  }

  /** Scroll a surface + read the long-task census over the scroll window.
   *
   * THE PROBE OWNS ITS PRECONDITIONS, and a probe that measured nothing
   * REFUSES: (1) the surface named by `surfaceSelector` must exist; (2)
   * a scrollable container must be found — the element itself or the
   * nearest ancestor whose content overflows (`.river` scrolls itself;
   * the old probes scrolled a non-overflowing PARENT, or scrolled DOWN
   * a surface already resting at its bottom, and reported the no-op as a
   * clean pass); (3) `scrollTop` must actually MOVE — travel is chosen
   * in the direction with room (a chat flow rests at its bottom, a river
   * at its top), each step's REAL clamped delta is accumulated, and the
   * travel is read back from the element afterwards; (4) the long-task
   * census must be live (the observer installed) — a dead observer reads
   * NaN and refuses. Only when all four hold is the census an honest
   * measured answer, and `longTaskCount: 0` then means "the scroll
   * stayed smooth", which is a real pass.
   *
   * `ok` is the PRECONDITION verdict only — budget judgment belongs to the
   * regression gate, not the probe. */
  async measureScrollLongTasks(
    name: string,
    surfaceSelector: string,
    opts: { stepPx: number; travelPx: number; settleMs: number },
  ): Promise<ScrollLongTaskReading> {
    await this.resetCounters();
    const start = await this.page.evaluate(
      ([sel, stepPx, travelPx]: [string, number, number]) => {
        const w = window as unknown as {
          __scrollProbe?: { interval: ReturnType<typeof setInterval>; moved: number; startTop: number; el: Element };
        };
        // A probe left armed by a previous call is cleared first — one
        // probe owns the window at a time.
        if (w.__scrollProbe !== undefined) clearInterval(w.__scrollProbe.interval);
        const base = document.querySelector(sel);
        if (base === null) {
          return { surfaceFound: false, surfaceReceivesInput: false, scrollableFound: false, resolved: "" };
        }
        const rect = base.getBoundingClientRect();
        const x = (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2;
        const y = (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2;
        const receiver = document.elementFromPoint(x, y);
        if (rect.width <= 0 || rect.height <= 0 || receiver === null || !base.contains(receiver)) {
          return { surfaceFound: true, surfaceReceivesInput: false, scrollableFound: false, resolved: "" };
        }
        // Walk self-then-ancestors for the element that actually scrolls.
        let el: Element | null = base;
        let hops = 0;
        while (el !== null && hops < 8) {
          if (el.scrollHeight - el.clientHeight > 1) break;
          el = el.parentElement;
          hops += 1;
        }
        if (el === null) {
          return { surfaceFound: true, surfaceReceivesInput: true, scrollableFound: false, resolved: "" };
        }
        const scrollable = el as Element & { scrollTop: number };
        const maxScroll = el.scrollHeight - el.clientHeight;
        const fromTop = scrollable.scrollTop;
        // Travel toward whichever end has room: a chat flow rests at its
        // bottom (nothing below to scroll into), a river at its top.
        const direction = fromTop >= maxScroll - fromTop ? -1 : 1;
        const budgetTravel = direction === -1 ? fromTop : maxScroll - fromTop;
        const stash = { interval: 0 as unknown as ReturnType<typeof setInterval>, moved: 0, startTop: fromTop, el };
        w.__scrollProbe = stash;
        let travelled = 0;
        const iv = setInterval(() => {
          const before = scrollable.scrollTop;
          scrollable.scrollTop += direction * stepPx;
          stash.moved += Math.abs(scrollable.scrollTop - before);
          travelled += stepPx;
          if (travelled >= travelPx || travelled >= budgetTravel) {
            clearInterval(iv);
            stash.interval = 0 as unknown as ReturnType<typeof setInterval>;
          }
        }, 16);
        stash.interval = iv;
        return {
          surfaceFound: true, surfaceReceivesInput: true, scrollableFound: true,
          resolved: (el.className || el.tagName).toString().slice(0, 40),
        };
      },
      [surfaceSelector, opts.stepPx, opts.travelPx] as [string, number, number],
    );
    await this.page.waitForTimeout(opts.settleMs);
    // Read the travel back AFTER the scroll ends: the read waits for the
    // probe's own interval to clear (bounded), then takes `moved` — the
    // sum of the element's OWN clamped per-step deltas (its account of how
    // far it really moved) — cross-checked against the end-to-start delta.
    const after = await this.page.evaluate(
      () =>
        new Promise<{ moved: number; endDelta: number } | null>((resolve) => {
          const w = (window as unknown as {
            __scrollProbe?: { interval: ReturnType<typeof setInterval>; moved: number; startTop: number; el: Element };
          }).__scrollProbe;
          if (w === undefined) {
            resolve(null);
            return;
          }
          const read = (): void => {
            const endDelta = Math.abs((w.el as Element & { scrollTop: number }).scrollTop - w.startTop);
            const moved = w.moved;
            delete (window as unknown as Record<string, unknown>).__scrollProbe;
            resolve({ moved, endDelta });
          };
          if (w.interval === (0 as unknown as ReturnType<typeof setInterval>)) {
            read();
            return;
          }
          const deadline = Date.now() + 5000;
          const poll = setInterval(() => {
            if (w.interval === (0 as unknown as ReturnType<typeof setInterval>) || Date.now() > deadline) {
              clearInterval(poll);
              clearInterval(w.interval);
              read();
            }
          }, 50);
        }),
    );
    const vitals = await this.readWebVitals();
    const scrolledPixels = after === null ? 0 : round(Math.min(after.moved, after.endDelta));
    const preconditions: string[] = [];
    if (!start.surfaceFound) preconditions.push(`the surface ("${surfaceSelector}") does not exist`);
    if (start.surfaceFound && !start.surfaceReceivesInput) preconditions.push(`the surface ("${surfaceSelector}") does not receive input at its visible center`);
    if (start.surfaceReceivesInput && !start.scrollableFound) {
      preconditions.push(`the surface ("${surfaceSelector}") has no scrollable container (its content does not overflow)`);
    }
    if (start.surfaceFound && start.scrollableFound && scrolledPixels <= 0) {
      preconditions.push("scrollTop never moved — the scroll travelled 0px");
    }
    if (!Number.isFinite(vitals.longTaskWorstMs)) {
      preconditions.push("the long-task census is not live (no observer)");
    }
    const ok = preconditions.length === 0;
    return {
      kind: "scroll-long-task", name,
      longTaskTotalMs: vitals.longTaskTotalMs,
      longTaskCount: vitals.longTaskCount,
      longTaskWorstMs: vitals.longTaskWorstMs,
      scrolledPixels,
      ok,
      note: ok
        ? `long-task census over the "${surfaceSelector}" scroll (${scrolledPixels}px travelled; resolved: ${start.resolved})`
        : `refused: ${preconditions.join("; ")}`,
    };
  }

  /** Measure typing latency into an input, through to the PERCEIVED SETTLE:
   * for each keystroke, from the `input` event to the frame AFTER the
   * reactive render — the second of two chained rAFs. The first rAF fires
   * at the START of the frame that renders the update (before style, layout
   * and paint), so a bracket that closes there measures the dispatch, not
   * the user's latency (the old single-rAF bracket read 1.4ms/key —
   * playwright's dispatch, not the settle). The second rAF fires at the
   * start of the NEXT frame, which proves the rendering frame completed —
   * the same input→next-paint window INP is defined over.
   *
   * The row carries `framePeriodMs` — the mean interval between the two
   * rAFs, i.e. the page's own rendered-frame clock measured over the very
   * keystrokes being judged. Every settle is mathematically ≥ its own
   * frame period (settle = dispatch-to-frame + frame period), so the
   * regression gate asserts `durationMs >= framePeriodMs` as the
   * non-arbitrary proof that the bracket includes the rendered frame —
   * a reverted dispatch-only bracket reads below it and reds. */
  async measureTyping(selector: string, text: string, name: string): Promise<
    LatencyMeasurement & { readonly framePeriodMs: number; readonly keys: number }
  > {
    const refused = (note: string): LatencyMeasurement & { readonly framePeriodMs: number; readonly keys: number } => ({
      kind: "latency", name, durationMs: NaN, ok: false, note, framePeriodMs: NaN, keys: 0,
    });
    try {
      const el = this.page.locator(selector).first();
      await el.click({ timeout: 5000 });
      await el.fill("", { timeout: 5000 });
      // Install the settle bracket: per keystroke, input → rAF → rAF. The
      // listener is removed after typing (the probe owns its instrument).
      await this.page.evaluate((sel: string) => {
        const node = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
        if (node === null) return;
        const w = window as unknown as {
          __typeTimes?: number[];
          __typePeriods?: number[];
          __typeListener?: () => void;
        };
        w.__typeTimes = [];
        w.__typePeriods = [];
        const listener = (): void => {
          const t0 = performance.now();
          requestAnimationFrame(() => {
            const t1 = performance.now();
            requestAnimationFrame(() => {
              const t2 = performance.now();
              w.__typeTimes!.push(t2 - t0);
              w.__typePeriods!.push(t2 - t1);
            });
          });
        };
        node.addEventListener("input", listener);
        w.__typeListener = () => node.removeEventListener("input", listener);
      }, selector);
      await el.pressSequentially(text, { delay: 16 });
      // The last keystroke's chained rAFs need ~2 frames after its keyup;
      // let the final settle land before reading the samples.
      await this.page.waitForTimeout(120);
      const samples = await this.page.evaluate(() => {
        const w = window as unknown as {
          __typeTimes?: number[];
          __typePeriods?: number[];
          __typeListener?: () => void;
        };
        w.__typeListener?.();
        const times = w.__typeTimes ?? [];
        const periods = w.__typePeriods ?? [];
        delete (window as unknown as Record<string, unknown>).__typeTimes;
        delete (window as unknown as Record<string, unknown>).__typePeriods;
        delete (window as unknown as Record<string, unknown>).__typeListener;
        return { times, periods };
      });
      if (samples.times.length === 0) {
        return refused("no keystroke settled — the input listener saw nothing (the field never fired an input event)");
      }
      const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
      const durationMs = round(mean(samples.times));
      const framePeriodMs = round(mean(samples.periods));
      if (!Number.isFinite(durationMs) || !Number.isFinite(framePeriodMs) || framePeriodMs <= 0) {
        return refused(
          `the settle never crossed a rendered frame boundary (framePeriodMs=${String(framePeriodMs)}) — ` +
          "the bracket cannot prove the keystrokes' renders, so nothing was measured",
        );
      }
      return {
        kind: "latency", name, durationMs, ok: true,
        note:
          `mean input→render-settle per keystroke over ${samples.times.length} keys ` +
          "(input event → second chained rAF, the frame after the reactive render); " +
          `framePeriodMs is the same keystrokes' mean rendered-frame period`,
        framePeriodMs, keys: samples.times.length,
      };
    } catch (err) {
      return refused(String((err as Error)?.message ?? err));
    }
  }

  /** Track the switch feed's OWN chats reads in flight, attributed by
   * issuer through the fetch call's own stack. The page-level request
   * events cannot tell issuers apart, and the 10k boot fires one chats
   * read of its own (`restoreKeptConversation`) beside the feed's bounded
   * queue — an inclusive counter measured 3 in flight against the feed's
   * cap of 2 and read as a breach that was really a reader the guarantee
   * never covered (measured 2026-09-02: initiator stacks named
   * boot/probes.ts:132 beside rooms/switch-feed.ts:75). A CDP
   * Network-domain counter was tried first and is NOT trustworthy under
   * the phase's `page.route` interception (it missed most
   * `requestWillBeSent` events — 63 of ~200 reads — and never saw
   * `loadingFinished` for intercepted requests, leaking a phantom peak
   * of 4; the same boot measured through an in-page fetch patch showed
   * the feed holding its cap of 2 exactly). The patch is installed as an
   * init script keyed on a sessionStorage flag: it arms before the
   * phase's reload (the fan-out starts inside the reveal frame), counts
   * only reads whose fetch-creation stack names switch-feed, and disarms
   * itself for every later document — later reloads run it as a
   * passthrough that never arms. */
  async instrumentFeedChatsReads(): Promise<{
    readonly read: () => Promise<{ readonly total: number; readonly peak: number }>;
    readonly uninstall: () => Promise<void>;
  }> {
    const ARM_FLAG = "perf:feed-chats-tracker";
    if (this.feedTrackerInstalled !== true) {
      this.feedTrackerInstalled = true;
      const origin = new URL(this.page.url()).origin;
      await this.page.addInitScript(({ flag, origin }: { flag: string; origin: string }) => {
        if (location.origin !== origin) return;
        if (sessionStorage.getItem(flag) !== "1") return;
        // The flag armed THIS document only — a later reload boots a new
        // document that finds no flag and never wraps fetch.
        sessionStorage.removeItem(flag);
        const w = window as unknown as { __feedChats?: { total: number; peak: number; inFlight: number } };
        w.__feedChats = { total: 0, peak: 0, inFlight: 0 };
        const realFetch: typeof window.fetch = window.fetch.bind(window);
        window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
          const tracker = w.__feedChats;
          const url = typeof input === "string" ? input : (input as Request).url;
          if (tracker === undefined || !url.includes("/api/projects/") || !url.includes("/chats")) {
            return realFetch(input as RequestInfo, init);
          }
          // Issuer attribution: the feed's reads are created with
          // switch-feed.ts on the fetch-creation stack; the boot's
          // restoreKeptConversation read is not.
          if (!/switch-feed/.test(new Error().stack ?? "")) {
            return realFetch(input as RequestInfo, init);
          }
          tracker.total += 1;
          tracker.inFlight += 1;
          if (tracker.inFlight > tracker.peak) tracker.peak = tracker.inFlight;
          const p = realFetch(input as RequestInfo, init);
          const settle = (): void => {
            tracker.inFlight = Math.max(0, tracker.inFlight - 1);
          };
          p.then(settle, settle);
          return p;
        }) as typeof window.fetch;
      }, { flag: ARM_FLAG, origin });
    }
    await this.page.evaluate((flag: string) => {
      sessionStorage.setItem(flag, "1");
    }, ARM_FLAG);
    return {
      read: async () =>
        await this.page.evaluate(() => {
          const t = (window as unknown as { __feedChats?: { total: number; peak: number } }).__feedChats;
          return t === undefined ? { total: 0, peak: 0 } : { total: t.total, peak: t.peak };
        }),
      uninstall: async () => {
        await this.page.evaluate((flag: string) => {
          sessionStorage.removeItem(flag);
          delete (window as unknown as Record<string, unknown>).__feedChats;
        }, ARM_FLAG).catch(() => {});
      },
    };
  }

  /** Capture one API response into the network log. */
  private captureResponse(res: Response): number | undefined {
    const request = res.request();
    const index = this.apiCallPositions.get(request);
    const url = index === undefined ? res.url() : undefined;
    if (url !== undefined && !url.includes("/api/")) return;
    const timing = request.timing();
    // Keep the existing API-response bracket: sending the request through
    // receiving its last byte, excluding earlier queue/connection setup.
    const responseMs = timing.requestStart >= 0 && timing.responseEnd >= timing.requestStart
      ? round(timing.responseEnd - timing.requestStart) : NaN;
    if (index !== undefined) {
      // Request identity owns immutable response metadata. Completion updates
      // timing and observation, then requestfinished acquires byte sizes.
      this.apiCalls[index] = { ...this.apiCalls[index]!, responseMs, timing: { ...timing }, observedAt: Date.now() };
      return index;
    }
    const headers = res.headers();
    const next = this.apiCalls.length;
    this.apiCallPositions.set(request, next);
    this.apiCalls.push({
      method: request.method(), url: url!.replace(/^https?:\/\/[^/]+/, ""),
      status: res.status(), bytes: NaN, responseMs, timing: { ...timing },
      traceId: headers["x-trace-id"] ?? null, observedAt: Date.now(),
      // Cache-Control describes cacheability, not this response's origin.
      // Playwright's response has no cache-hit provenance, so retain unknown.
      fromCache: null, compressed: (headers["content-encoding"] ?? "") !== "",
    });
    return next;
  }

  /** All observed response rows, updated when their own requests finish. */
  getApiCalls(): readonly ApiCall[] {
    return this.apiCalls.slice();
  }

  /** Snapshot each request's completed timing and encoded body + HTTP header
   * size (these sizes do not establish cache origin or network transfer). A
   * document's Resource Timing buffer is bounded and disappears on reload;
   * URL joins cannot associate its remaining entries with earlier requests. */
  async finalizeNetwork(): Promise<void> {
    // Drain acquisitions already started by the requestfinished owner. No
    // remote request method is deferred to this late report boundary.
    while (this.pendingNetworkSizes.size > 0) await Promise.all(this.pendingNetworkSizes);
    if (this.networkCaptureFailure !== undefined) throw this.networkCaptureFailure.error;
    this.finalizedCalls = this.apiCalls.slice();
  }

  /** The final snapshot, or the current response rows before finalization. */
  getFinalizedNetwork(): readonly ApiCall[] {
    return this.finalizedCalls === null ? this.getApiCalls() : this.finalizedCalls.slice();
  }

  /** Summarise the captured network log. Uses the finalized request
   * snapshot if `finalizeNetwork()` was called; otherwise the current rows. */
  networkSummary(): ProfileReport["networkSummary"] {
    const calls = this.finalizedCalls ?? this.apiCalls;
    const totalCalls = calls.length;
    let totalBytes = 0, compressedCount = 0, timedCount = 0, timedSum = 0, max = -Infinity;
    let cachedCount: number | null = 0;
    let slowest: { url: string; responseMs: number } | null = null;
    for (const call of calls) {
      totalBytes += call.bytes;
      if (call.compressed) compressedCount++;
      if (call.fromCache === null) cachedCount = null;
      else if (call.fromCache && cachedCount !== null) cachedCount++;
      if (!Number.isFinite(call.responseMs)) continue;
      timedCount++;
      timedSum += call.responseMs;
      // Preserve Math.max's signed-zero semantics, while the first tied
      // response remains the named slowest request.
      max = Math.max(max, call.responseMs);
      if (slowest === null || call.responseMs > slowest.responseMs) slowest = { url: call.url, responseMs: call.responseMs };
    }
    const avg = timedCount > 0 ? timedSum / timedCount : NaN;
    return {
      totalCalls, totalBytes: round(totalBytes), compressedCount, cachedCount,
      slowest, avgResponseMs: round(avg), maxResponseMs: timedCount > 0 ? round(max) : NaN,
    };
  }

  /** Compute long-session memory growth from the collected snapshots.
   * Scoped by LABEL: the long session's window is "long-session-start"→
   * "long-session-end". First↔last would answer a different question —
   * the whole profile's settling since boot (measured 2026-08-30: 3,755
   * nodes of room first-mounts misread as session growth, while the named
   * window's own snapshots were stable at 3,960 — zero growth). When the
   * named window's snapshots are missing, growth was NOT measured — NaN,
   * never 0 (a zero would pass every leak budget without measuring
   * anything). */
  longSessionGrowth(): ProfileReport["longSession"] {
    const snaps = this.memSnapshots;
    const start = snaps.find((s) => s.label === "long-session-start");
    const end = snaps.find((s) => s.label === "long-session-end");
    if (start === undefined || end === undefined) {
      return { heapGrowthMb: NaN, domNodeGrowth: NaN };
    }
    return {
      heapGrowthMb: round(end.jsHeapUsedMb - start.jsHeapUsedMb, 2),
      domNodeGrowth: end.domNodes - start.domNodes,
    };
  }

  /** All collected memory snapshots. */
  getMemorySnapshots(): readonly MemorySnapshot[] {
    return this.memSnapshots.slice();
  }

  /** Discover every interactive element on the page via a DOM scan
   * (deny-by-default: a newly added button/link/input is auto-profiled — no
   * hardcoded list). The `idx` is the element's position among ALL
   * elements of its tag in the document, so `page.locator(tag).nth(idx)`
   * re-locates it reliably (unlike a CSS `nth-of-type` selector, which is
   * relative to the parent). Filters out hidden + disabled elements so the
   * profile only measures elements a user could actually interact with. */
  async discoverInteractiveElements(): Promise<InteractiveElement[]> {
    return await this.page.evaluate(() => {
      const sel = [
        "button",
        '[role="button"]',
        "a[href]",
        'input:not([type="hidden"])',
        "textarea",
        "select",
        '[role="menuitem"]',
        '[role="option"]',
        '[role="switch"]',
        '[role="checkbox"]',
        '[role="radio"]',
      ].join(",");
      // Build per-tag index maps so each element's `idx` is its position
      // among all elements of its tag (the key Playwright's .nth() uses).
      const allByTag = new Map<string, Element[]>();
      const out: InteractiveElement[] = [];
      const nodes = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
      for (const n of nodes) {
        const rect = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        const visible = rect.width > 0 && rect.height > 0
          && style.visibility !== "hidden"
          && style.display !== "none"
          && (n as HTMLButtonElement).disabled !== true;
        const tag = n.tagName.toLowerCase();
        const role = n.getAttribute("role") ?? tag;
        const ariaLabel = (n.getAttribute("aria-label") ?? "").trim();
        const textContent = (n.textContent ?? "").trim().slice(0, 60);
        const placeholder = (n as HTMLInputElement).placeholder ?? "";
        const titleAttr = (n.getAttribute("title") ?? "").trim();
        const label = (ariaLabel || textContent || placeholder || titleAttr || tag);
        // Compute the per-tag index (lazy: build the list on first use).
        let tagList = allByTag.get(tag);
        if (tagList === undefined) {
          tagList = Array.from(document.querySelectorAll(tag));
          allByTag.set(tag, tagList);
        }
        const idx = tagList.indexOf(n);
        const stamp = `pi${Date.now().toString(36)}-${out.length}`;
        n.setAttribute("data-perf-identity", stamp);
        out.push({ role, label: label.slice(0, 60), tag, idx, stamp, visible });
      }
      return out;
    });
  }

  /** Click one interactive element + measure the click→next-frame latency
   * (an INP proxy). Non-visible elements are refused (ok:false with a
   * note) so the profile never flags a hidden element as a regression.
   * Locates by the node's OWN stamp, never `nth(idx)`: a positional locator
   * re-resolves against the current DOM at click time, and any earlier click
   * that mutated the DOM (a menu opening inserts buttons mid-list) re-aims
   * the click at the wrong control — measured landed on "sign out". */
  async profileInteraction(el: InteractiveElement): Promise<InteractiveProfile> {
    if (!el.visible) {
      return { role: el.role, label: el.label, tag: el.tag, clickMs: NaN, longTaskWorstMs: NaN, ok: false, note: "not visible" };
    }
    try {
      await this.resetCounters();
      const loc = this.page.locator(`[data-perf-identity="${el.stamp}"]`);
      // Scroll into view so the click is not intercepted. Setup, not signal:
      // the clock starts at the CLICK — the budgeted number is input→frame
      // latency (an INP proxy), and scroll time is the instrument's travel
      // to the target, never something the user paid for. Set __t0 after
      // the scroll or a long page quietly charges its own length into every
      // click (measured: "instruments" open read 204ms vs a 200ms budget
      // with nothing in the room itself out of place).
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
      await this.page.evaluate(() => {
        (window as { __t0?: number }).__t0 = performance.now();
      });
      await loc.click({ timeout: 2000 });
      // Wait one animation frame for the render to settle (the click may
      // open a menu, toggle a state, navigate — all render within a frame).
      await this.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
      const dur = await this.page.evaluate(() => performance.now() - ((window as { __t0?: number }).__t0 ?? 0));
      const vitals = await this.readWebVitals();
      const censusLive = Number.isFinite(vitals.longTaskWorstMs);
      return {
        role: el.role, label: el.label, tag: el.tag, clickMs: round(dur),
        longTaskWorstMs: vitals.longTaskWorstMs,
        ok: censusLive,
        note: censusLive
          ? "click → next frame (input→render settle); longTaskWorstMs is the same window's census"
          : "refused: the long-task census is not live (no observer)",
      };
    } catch (err) {
      // Some clicks are intentionally inert (e.g. a disabled-looking button
      // that fails the actionability check). Record the failure honestly.
      return { role: el.role, label: el.label, tag: el.tag, clickMs: NaN, longTaskWorstMs: NaN, ok: false, note: String((err as Error)?.message ?? err).slice(0, 80) };
    }
  }

  /** Read a GPU proxy: the number of paint entries observed + whether a
   * WebGL canvas is present (the intelligence graph). The paint count is a
   * cheap proxy for GPU activity; the canvas presence flags whether the
   * GPU-accelerated path is exercised. */
  async readGpuProxy(): Promise<{ paintCount: number; hasWebGLCanvas: boolean }> {
    return await this.page.evaluate(() => {
      const paints = (performance.getEntriesByType("paint") ?? []).length;
      const canvases = Array.from(document.querySelectorAll("canvas"));
      let hasWebGL = false;
      for (const c of canvases) {
        const ctx = c.getContext("webgl") ?? c.getContext("webgl2");
        if (ctx !== null) { hasWebGL = true; break; }
      }
      return { paintCount: paints, hasWebGLCanvas: hasWebGL };
    });
  }
}

/** Log in via the API (programmatic — faster + deterministic than driving
 * the form for every profile run) and add the session cookie to the browser
 * context. The CSRF custom header is required for unsafe methods. */
export async function apiLogin(
  page: Page,
  opts: { baseURL: string; username: string; password: string },
): Promise<void> {
  const ctx = page.context();
  const res = await ctx.request.post(`${opts.baseURL}/api/auth/login`, {
    data: { username: opts.username, password: opts.password },
    headers: { "x-requested-with": "1" },
  });
  if (!res.ok()) throw new Error(`login failed: ${res.status()}`);
  // The Set-Cookie is now in the context's cookie jar — no manual wiring.
}

// ── Dynamic API-route discovery (deny-by-default: scans the server route
// source so a newly added route is auto-discovered — no hardcoded list). ──

/** Scan `server/routes/*.ts` for `router.METHOD("/path", ...)` calls and
 * return one `DiscoveredRoute` per call. The method + path are extracted via
 * a regex (no AST — the route files use a single uniform `router.METHOD(
 * "/api/...", ...)` shape verified by the route-registry prevention test).
 * Mutating methods (POST/PUT/PATCH/DELETE) are marked `profiled: false` so
 * the harness never auto-calls a destructive endpoint; GET + the known
 * read-only POSTs (`/api/timeline/query`, `/api/memory/search`) are profiled. */
export async function discoverApiRoutesFromSource(
  serverRoot: string,
): Promise<DiscoveredRoute[]> {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = join(serverRoot, "routes");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  const routes: DiscoveredRoute[] = [];
  const re = /router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
  // Read-only POST endpoints (queries that happen to use POST for body
  // semantics). A new read-only POST must be added here to be profiled —
  // deny-by-default: a POST is mutating unless explicitly marked.
  const SAFE_POST_PATHS = new Set(["/api/timeline/query", "/api/memory/search"]);
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const method = m[1]!.toUpperCase();
      const path = m[2]!;
      const canProfile = method === "GET" || (method === "POST" && SAFE_POST_PATHS.has(path));
      routes.push({
        method,
        path,
        sourceFile: `routes/${f}`,
        profiled: canProfile,
        reason: canProfile ? "" : `mutating ${method} — not auto-profiled`,
      });
    }
  }
  return routes;
}

/** Sample IDs are keyed by the route's named parameter. A generic `:id`
 * belongs to its preceding collection: `chats/:id` consumes `chatId`,
 * never another entity's ID. Collections outside that naming convention
 * remain unknown unless their route names its parameter explicitly. */
type RouteSamples = Readonly<Record<string, string>>;

function resolveRoutePath(path: string, samples: RouteSamples): string {
  const segments = path.split("/");
  return segments.map((segment, index) => {
    if (!segment.startsWith(":")) return segment;
    const name = segment.slice(1);
    const key = name === "id"
      ? Object.keys(samples).find((candidate) => candidate.endsWith("Id")
        && `${candidate.replace(/Id$/, "")}s` === segments[index - 1])
      : name;
    const value = key === undefined ? undefined : samples[key];
    return encodeURIComponent(value ?? (name === "runId" ? "perf-sample-run" : "perf-sample"));
  }).join("/");
}

/** Profile every profileable discovered route by calling it with the
 * authenticated session cookie. Measures response time, status, bytes. GET
 * routes are called as-is; read-only POSTs get an empty body. Returns one
 * `RouteProfile` per profiled route. A 4xx/5xx is still a valid measurement
 * (the server's error path) — `ok` flags whether the response was
 * well-formed, not whether it was 2xx.
 *
 * MUST be called BEFORE the page navigates (the profile spec calls it with
 * the page still at `about:blank`): the server runs every request on one
 * event loop, so a route timed while a browser session is running measures
 * the session's contention, not the route. The calls go through the API
 * request context — they do not fire the page's response listener, so they
 * stay out of the network log + the isolation call count.
 *
 * MEASURED CALLS ARE STEADY-STATE: every route gets ONE WARMUP call before
 * the measured one, then a short drain. The warmup absorbs the two costs
 * that are foreign to the route being judged: (1) the first call's one-time
 * work (a lazily-loaded module, a first-use JIT of a heavy path) and (2) the
 * PRECEDING request's post-response tail — every served request appends its
 * own http event to the timeline ledger AFTER the response is written, and
 * the next request's timer starts while that append (occasionally a WAL
 * checkpoint) is still on the server's single event loop. Without the
 * warmup, one route absorbs a neighbour's tail and the report blames the
 * route (measured: the same route answered 632ms in one phase run and
 * 127ms in another, differing only in what the neighbouring requests left
 * on the loop). A route whose WARMUP times out is an SSE-class stream —
 * unmeasurable in isolation — and is recorded ok:false from the warmup
 * itself; measuring it twice would just spend the timeout twice. */
export async function profileApiRoutes(
  page: Page,
  routes: readonly DiscoveredRoute[],
  opts: { baseURL: string; samples: RouteSamples },
): Promise<RouteProfile[]> {
  const ctx = page.context();
  const results: RouteProfile[] = [];
  // Every call is BOUNDED. Some discovered GETs are SSE streams (`/api/live`,
  // run streams) that never complete by design — unbounded, one of them
  // spends the entire profile budget and the run dies with a bare timeout.
  // A route that cannot answer inside the bound is recorded ok:false with
  // the timeout note, which is a finding, not a crash.
  const ROUTE_CALL_TIMEOUT_MS = 15_000;
  // The drain between a route's warmup and its measured call: long enough
  // for the warmup's post-response ledger append to leave the server's
  // event loop, so the measured timer starts on a quiet server. See the
  // function's doc comment for why the warmup exists at all. (Measured: a
  // 1s drain did not change the profile's slowest route, so the tail this
  // waits for is not the whole story — the endpoint itself was still cold.)
  const WARMUP_DRAIN_MS = 60;
  for (const r of routes) {
    if (!r.profiled) continue;
    const resolved = resolveRoutePath(r.path, opts.samples);
    const callRoute = async (): Promise<{ status: number; bytes: number }> => {
      const res = r.method === "GET"
        ? await ctx.request.get(`${opts.baseURL}${resolved}`, { headers: { "x-requested-with": "1" }, timeout: ROUTE_CALL_TIMEOUT_MS })
        : await ctx.request.post(`${opts.baseURL}${resolved}`, { data: {}, headers: { "x-requested-with": "1" }, timeout: ROUTE_CALL_TIMEOUT_MS });
      return {
        status: res.status(),
        bytes: Number(res.headers()["content-length"] ?? 0) || (await res.body()).length,
      };
    };
    try {
      // WARMUP — absorbs the first call's one-time work and the preceding
      // request's post-response tail. A timeout here means the route is an
      // SSE-class stream: record the finding from the warmup and move on
      // (a second call would only spend the timeout again).
      let warmupMs = Number.NaN;
      try {
        const warmupT0 = Date.now();
        await callRoute();
        warmupMs = Date.now() - warmupT0;
      } catch (warmupErr) {
        results.push({
          method: r.method, path: resolved, status: 0, responseMs: NaN, warmupMs: Number.NaN, bytes: 0, ok: false,
          note: `warmup: ${String((warmupErr as Error)?.message ?? warmupErr).slice(0, 60)}`,
        });
        continue;
      }
      await page.waitForTimeout(WARMUP_DRAIN_MS);
      // MEASURED — the steady-state call the budget judges.
      const t0 = Date.now();
      const { status, bytes } = await callRoute();
      const responseMs = Date.now() - t0;
      results.push({
        method: r.method, path: resolved, status, responseMs, warmupMs, bytes, ok: true, note: "",
      });
    } catch (err) {
      results.push({
        method: r.method, path: resolved, status: 0, responseMs: NaN, warmupMs: Number.NaN, bytes: 0, ok: false,
        note: String((err as Error)?.message ?? err).slice(0, 80),
      });
    }
  }
  return results;
}

// ── Real-data seeding ──

/** Insert N messages into a chat via the API (realistic — exercises the real
 * POST path). Alternates user/assistant roles with synthetic content so the
 * chat renders a realistic alternating transcript. Returns the wall time.
 * NOTE: the server rate-limits mutating requests (default 60/min/session),
 * so for large counts use `seedChatMessagesViaDb` instead. */
export async function seedChatMessages(
  page: Page,
  opts: { baseURL: string; chatId: string; count: number },
): Promise<{ inserted: number; wallMs: number }> {
  const ctx = page.context();
  const t0 = Date.now();
  let inserted = 0;
  for (let i = 0; i < opts.count; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    const content = `perf-seed message ${i}: ${role} turn with some content to render — ${"x".repeat(40)}`;
    const res = await ctx.request.post(`${opts.baseURL}/api/chats/${opts.chatId}/messages`, {
      data: { role, content },
      headers: { "x-requested-with": "1" },
    });
    if (res.ok()) inserted++;
  }
  return { inserted, wallMs: Date.now() - t0 };
}

/** Prepare messages on a fixture connection already owned by the stopped-service
 * preparation lane. This helper never opens or closes a database. Any failed
 * insert escapes the transaction, so a partial seed is rolled back. */
export function seedChatMessagesViaDb(
  db: DbClient,
  opts: { chatId: string; count: number; username?: string },
): { inserted: number; messageIds: string[]; wallMs: number } {
  assert(Number.isSafeInteger(opts.count) && opts.count > 0);
  const user = db.getUserByUsername(opts.username ?? "admin");
  assert(user !== null, "prepared fixture user is absent");
  assert(db.getChat(opts.chatId, user.id) !== null, "prepared chat is not owned by the fixture user");
  assert.equal(db.countMessages(opts.chatId, user.id), 0, "prepared long chat must start empty");
  const started = performance.now();
  const messageIds = db.withTransaction(() => {
    const ids: string[] = [];
    for (let i = 0; i < opts.count; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      const content = `perf-seed message ${i}: ${role} turn with some content to render — ${"x".repeat(40)}`;
      ids.push(db.createMessage({ chat_id: opts.chatId, role, content }, user.id).id);
    }
    assert.equal(db.countMessages(opts.chatId, user.id), opts.count);
    return ids;
  });
  return { inserted: messageIds.length, messageIds, wallMs: performance.now() - started };
}

/** Refuse an inferred retry: every failed project must be a distinct member
 * of the expected terminal population with its own actual transport error. */
export function qualifyProjectRecovery(expected: ReadonlySet<string>, completed: ReadonlySet<string>, failed: readonly string[], transport: readonly Readonly<{ projectId: string; errorText: string | null }>[]): void {
  assert(failed.length > 0, "recovery requires actual failed projects");
  assert.equal(new Set(failed).size, failed.length, "failed project identities must be distinct");
  assert.equal(failed.length + completed.size, expected.size, "initial terminal project population must be complete");
  for (const id of completed) assert(expected.has(id), "completed project is outside the expected population");
  const transportIds = new Set<string>();
  for (const row of transport) if (typeof row.errorText === "string" && row.errorText.length > 0) transportIds.add(row.projectId);
  for (const id of failed) {
    assert(expected.has(id) && !completed.has(id), "failed project must be an expected uncompleted identity");
    assert(transportIds.has(id), "failed project requires its own recorded transport failure");
  }
}

export type PreparedProfileFixture = Readonly<{
  dbPath: string;
  /** The fixture's key home (the server gets it as HARNESS_KEY_HOME). */
  keyHome: string;
  closedBeforeServing: boolean;
  projectIds: readonly string[];
  chatIds: readonly string[];
  longChat: Readonly<{ projectId: string; chatId: string; messageIds: readonly string[]; messageCount: number }>;
}>;

/** The browser consumes the stopped preparation's exact population, never a
 * claimed DOM count. Absent or partial preparation refuses before login. */
export function readPreparedProfileFixture(path: string | undefined): PreparedProfileFixture {
  assert(path, "HARNESS_PERF_FIXTURE_PATH must name a closed, prepared profile fixture manifest; prepare with: node tests/performance/scale/prepare-fixture.ts cockpit <fresh-directory>");
  const fixture = JSON.parse(readFileSync(path, "utf8")) as PreparedProfileFixture;
  assert.equal(fixture.closedBeforeServing, true);
  assert.equal(typeof fixture.dbPath, "string");
  assert.equal(typeof fixture.keyHome, "string");
  for (const [name, ids, count] of [["projects", fixture.projectIds, 10000], ["chats", fixture.chatIds, 10000], ["messages", fixture.longChat.messageIds, 1000]] as const) {
    assert(Array.isArray(ids) && ids.every(id => typeof id === "string" && id.length > 0), `${name} IDs must be present`);
    assert.equal(ids.length, count, `${name} prepared population`);
    assert.equal(new Set(ids).size, count, `${name} distinct prepared population`);
  }
  assert.equal(fixture.longChat.messageCount, 1000);
  assert(fixture.projectIds.includes(fixture.longChat.projectId));
  assert(fixture.chatIds.includes(fixture.longChat.chatId));
  return fixture;
}

/** Build the final structured report from a harness run. */
export function buildReport(parts: {
  url: string;
  userAgent: string;
  viewport: { width: number; height: number };
  pageLoad: WebVitals;
  /**
   * REQUIRED so the report always carries the cold-vite warm-up evidence
   * (omitting it is a compile error at the single call site — the same
   * deny-by-default shape as `routeIsolation` and `treeIdentity` above).
   */
  pageLoadWarmUp: { readonly wallClockMs: number };
  cdpAtLoad: CdpMetrics;
  harness: PerfHarness;
  tabs: ProfileReport["tabs"];
  interactions: readonly InteractionMeasurement[];
  interactiveElements?: readonly InteractiveProfile[];
  discoveredRoutes?: readonly DiscoveredRoute[];
  routeProfiles?: readonly RouteProfile[];
  /** Isolation evidence for the route timings — REQUIRED so the report
   * always carries the proof that the routes were timed before the browser
   * session (omitting it is a compile error at the single call site). */
  routeIsolation: { readonly pageUrl: string; readonly browserApiCallsAtMeasure: number };
  /** REQUIRED so the report always carries the tree it measured (omitting it
   * is a compile error at the single call site — the same deny-by-default
   * shape as `routeIsolation` above). */
  treeIdentity: TreeIdentity;
  realData?: ProfileReport["realData"];
  viewports?: readonly ViewportProfile[];
}): ProfileReport {
  const network = parts.harness.getFinalizedNetwork();
  const routeProfiles = parts.routeProfiles ?? [];
  const discovered = parts.discoveredRoutes ?? [];
  const profiled = routeProfiles.filter((r) => Number.isFinite(r.responseMs));
  // No route timed is not measured-zero: the max reads NaN (`null` once
  // JSON has serialized it), the same not-measured shape the rest of the
  // report takes.
  const maxResponseMs = profiled.length > 0 ? Math.max(...profiled.map((r) => r.responseMs)) : Number.NaN;
  const slowestProfiled = profiled.reduce<RouteProfile | null>(
    (acc, r) => acc === null || r.responseMs > acc.responseMs ? r : acc,
    null,
  );
  return {
    generatedAt: new Date().toISOString(),
    treeIdentity: parts.treeIdentity,
    url: parts.url,
    userAgent: parts.userAgent,
    viewport: parts.viewport,
    pageLoad: parts.pageLoad,
    pageLoadWarmUp: parts.pageLoadWarmUp,
    cdpAtLoad: parts.cdpAtLoad,
    network,
    networkSummary: parts.harness.networkSummary(),
    tabs: parts.tabs,
    interactions: parts.interactions,
    interactiveElements: parts.interactiveElements ?? [],
    discoveredRoutes: discovered,
    routeProfiles,
    routeSummary: {
      totalDiscovered: discovered.length,
      totalProfiled: routeProfiles.length,
      maxResponseMs: round(maxResponseMs),
      slowest: slowestProfiled === null
        ? null
        : { method: slowestProfiled.method, path: slowestProfiled.path, responseMs: round(slowestProfiled.responseMs) },
      isolation: parts.routeIsolation,
    },
    realData: parts.realData ?? {
      longChat: {
        visibleConversation: false, inputScrollPixels: 0,
        messageCount: 0, loadedMessages: 0, wireMessages: 0, populationMatches: false, renderMs: NaN, domNodes: NaN,
        scroll: { longTaskTotalMs: NaN, longTaskCount: NaN, longTaskWorstMs: NaN, scrolledPixels: 0, ok: false, note: "the phase did not run" },
        ok: false,
      },
      manyProjects: {
        retriedProjectIds: [],
        projectCount: 0, completedProjects: 0, loadedProjects: 0, chatCount: 0, mountedCaps: 0, mountedReels: 0, populationMatches: false, completionMs: NaN, renderMs: NaN,
        ok: false, chatsFetches: 0, maxChatsInFlight: 0,
      },
    },
    viewports: parts.viewports ?? [],
    memory: parts.harness.getMemorySnapshots(),
    longSession: parts.harness.longSessionGrowth(),
  };
}

/** Write a report to disk as pretty JSON. */
export async function writeReport(path: string, report: ProfileReport): Promise<void> {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", "utf8");
}

/** The canonical on-disk path for the profile report. Single owner — both
 * the Playwright profile (writer) and the vitest regression gate (reader)
 * import this so the path cannot drift between them. Uses `import.meta`
 * (ESM) so it works under `"type": "module"`. Resolves to
 * `tests/performance/.report.json` (the lib file is one directory down, so
 * the path walks up from `lib/` to the performance root). */
export const REPORT_PATH: string = new URL("../.report.json", import.meta.url).pathname;

/**
 * Where the profile spec writes the report it builds: a file in its own run's
 * scratch, named by the perf-profile step (scripts/testing/perf-profile.ts),
 * which runs confined and hands the report back on its result channel; the
 * step's unconfined door writes {@link REPORT_PATH}. A confined run never
 * writes the checkout.
 */
export const PROFILE_REPORT_OUT_ENV = "HARNESS_PERF_REPORT_OUT";

/** The report's destination for this run (`PROFILE_REPORT_OUT_ENV`); the spec runs only under the perf-profile step. */
export function profileReportOut(): string {
  const out = process.env[PROFILE_REPORT_OUT_ENV];
  if (out === undefined || out.length === 0) throw new Error(`${PROFILE_REPORT_OUT_ENV} names no file: the profile spec runs only under \`npm run perf:profile\``);
  return out;
}

/** The regression gate's suite title, as the gate RENDERS it. THE TITLES ARE
 * LEDGER IDENTITIES: the run-history ledger records every failure as
 * `<file>::<suite title> > <test title>`, and the flaky-test memory's
 * freshness exclusion (the pre-mint rows the standing mint-last
 * discipline guarantees) keys on the freshness arm's composed identity.
 * The declarations live here — one place for every identity consumer —
 * and are MIRRORS of the titles the gate renders, pinned to them by an
 * exact contract test in the flaky guard (it extracts the gate's two
 * rendered title literals and asserts they equal these declarations, so
 * a rename at either end reds the day it happens instead of silently
 * detaching the exclusion from the rows it names). */
export const REGRESSION_GATE_SUITE_TITLE = "web UI performance regression gate";

/** The freshness arm's test title, as the gate renders it — the one arm
 * whose red says "the report no longer describes the current code". See
 * `REGRESSION_GATE_SUITE_TITLE` for why the title is declared here: it is
 * the load-bearing half of the arm's ledger identity. */
export const FRESHNESS_ARM_TEST_TITLE =
  "the report describes the current code (the measured surface's content hash matches the repository's)";
