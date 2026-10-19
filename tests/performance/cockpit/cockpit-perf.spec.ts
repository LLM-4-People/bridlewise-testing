/**
 * THE COCKPIT PERFORMANCE SWEEP.
 *
 * One spec, three targets, selected by env so the same measurements can be
 * compared across builds and data scales without a second copy of the code:
 *
 *   PERF_BASE   — where the client is served (default the dev server)
 *   PERF_USER / PERF_PASS — the session to measure as
 *   PERF_LABEL  — what to call this run in the report
 *
 *   dev:      PERF_BASE=http://127.0.0.1:5173
 *   prod:     PERF_BASE=http://127.0.0.1:5401   (tests/performance/cockpit/preview-server.ts)
 *   scale:    PERF_BASE=http://127.0.0.1:5399   (tests/performance/scale/stack.ts <profile>)
 *
 * WHY PLAYWRIGHT AND NOT THE INTERACTIVE BROWSER. Measuring through a
 * shared desktop browser turned out to be unsound: whenever the tab lost
 * focus, requestAnimationFrame throttled to roughly 1Hz, and every latency
 * silently became ~1000ms — including a "1 second boot reveal" that was
 * entirely an artifact of the measuring tab being in the background. A
 * driven browser page is always foreground-equivalent, and `assertFrameClock`
 * proves it per run rather than assuming it. Any run whose frame clock is
 * not real FAILS instead of reporting.
 *
 * WHAT THE NUMBERS SEPARATE. The server has no isolation between
 * connections — every DB touch is synchronous on its one event loop — so a
 * stall in the browser can be the server blocking rather than the client
 * working. Every interaction therefore records, over its own window: time
 * with a request in flight, long-task time, and the settle time. A slow
 * interaction with no long tasks and a request in flight is a SERVER
 * finding; a slow interaction with long tasks and no network is a CLIENT
 * finding. Guessing between those two is how perf work goes wrong.
 *
 * @test-only
 */
import { test, expect, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const BASE = process.env["PERF_BASE"] ?? "http://127.0.0.1:5173";
const USER = process.env["PERF_USER"] ?? "admin";
// The dev password comes from the environment ONLY (no literal fallback in a tracked file).
const PASS = process.env["PERF_PASS"] ?? (() => { throw new Error("set PERF_PASS to the dev server's admin password (no built-in default)"); })();
const LABEL = process.env["PERF_LABEL"] ?? "dev";
const OUT = process.env["PERF_OUT"] ?? join("tests", "performance", ".cockpit-report", `${LABEL}.json`);

const COCKPIT = `${BASE}/`;

/** The reveal gate — the honest "usable" moment (DESIGN-COCKPIT-V2 §10.3). */
const REVEALED = '.cockpit[data-revealed="true"]';
/** A room is on screen. Rooms are kept alive and flipped, never unmounted. */
const ACTIVE_ROOM = 'section.room[data-room-active="true"]';

/** Injected before any app code. Raises the resource-timing buffer past its
 * 250-entry default (a cockpit boot fills it exactly, silently dropping the
 * tail), arms the observers, and wraps fetch for exact in-flight windows. */
const INIT = `
(() => {
  const w = window;
  try { performance.setResourceTimingBufferSize(2000); } catch (e) {}
  const P = { longTasks: [], shifts: 0, shiftValue: 0, fetches: [], revealAt: null, frames: [] };
  w.__probe = P;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longTasks.push({ start: e.startTime, dur: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (!e.hadRecentInput) { P.shifts += 1; P.shiftValue += e.value; } } }).observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
  const of = w.fetch;
  w.fetch = function (...a) {
    const u = String(a[0] && a[0].url ? a[0].url : a[0]).replace(/^https?:\\/\\/[^/]+/, '');
    const rec = { url: u, start: performance.now(), end: null, status: null, bytes: null };
    P.fetches.push(rec);
    return of.apply(this, a).then((r) => {
      rec.end = performance.now(); rec.status = r.status;
      try { r.clone().arrayBuffer().then((b) => { rec.bytes = b.byteLength; }, () => {}); } catch (e) {}
      return r;
    }, (e) => { rec.end = performance.now(); rec.status = -1; throw e; });
  };
  const mark = () => { if (P.revealAt === null && document.querySelector('${REVEALED}')) { P.revealAt = performance.now(); return true; } return false; };
  const go = () => { if (mark()) return; const mo = new MutationObserver(() => { if (mark()) mo.disconnect(); }); mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})();
`;

/** Refuse to measure behind a throttled frame clock. See the header. */
async function assertFrameClock(page: Page): Promise<number> {
  const median = await page.evaluate(async () => {
    const t0 = performance.now();
    const f: number[] = [];
    await new Promise<void>((r) => {
      let n = 0;
      const tick = (): void => { f.push(performance.now() - t0); if (++n < 12) requestAnimationFrame(tick); else r(); };
      requestAnimationFrame(tick);
    });
    const d = f.slice(1).map((v, i) => v - f[i]!).sort((a, b) => a - b);
    return d[Math.floor(d.length / 2)]!;
  });
  expect(median, "frame clock must be real — a throttled rAF voids every latency number").toBeLessThan(30);
  return median;
}

/** Union length of intervals (overlapping requests occupy wall time once). */
function unionMs(iv: ReadonlyArray<{ start: number; end: number }>): number {
  const s = iv.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  let total = 0, cs = Number.NaN, ce = Number.NaN;
  for (const i of s) {
    if (Number.isNaN(cs)) { cs = i.start; ce = i.end; continue; }
    if (i.start > ce) { total += ce - cs; cs = i.start; ce = i.end; } else if (i.end > ce) ce = i.end;
  }
  return Number.isNaN(cs) ? 0 : total + (ce - cs);
}

type Interaction = {
  name: string; ackMs: number | null; settleMs: number | null;
  longTaskMs: number; worstLongTaskMs: number; networkMs: number;
  requests: number; attribution: string; note: string;
};

/**
 * Measure one interaction: click, then wait for `ack` to hold, then let the
 * DOM go quiet. Records what the time was SPENT on, not merely how long it
 * took — see the header on why that distinction is the whole point.
 */
async function interact(
  page: Page, name: string, click: () => Promise<void>, ackSelector: string | null,
): Promise<Interaction> {
  await page.evaluate(() => {
    const P = (window as any).__probe;
    P.__mark = performance.now();
    P.__lt0 = P.longTasks.length;
    P.__fx0 = P.fetches.length;
  });
  const t0 = Date.now();
  let note = "";
  try {
    await click();
    if (ackSelector !== null) await page.waitForSelector(ackSelector, { state: "visible", timeout: 15_000 });
  } catch (e) { note = String((e as Error).message).slice(0, 100); }
  // Let the DOM settle before reading the counters.
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => {
    const P = (window as any).__probe;
    const mark = P.__mark as number;
    const lt = P.longTasks.slice(P.__lt0).filter((t: any) => t.start >= mark);
    const fx = P.fetches.slice(P.__fx0).filter((f: any) => f.end !== null);
    return {
      longTaskMs: lt.reduce((s: number, t: any) => s + t.dur, 0),
      worst: lt.length ? Math.max(...lt.map((t: any) => t.dur)) : 0,
      fetches: fx.map((f: any) => ({ start: f.start, end: f.end, url: f.url })),
    };
  });
  const settleMs = Date.now() - t0 - 400;
  const networkMs = Math.round(unionMs(r.fetches));
  const attribution =
    r.longTaskMs > networkMs && r.longTaskMs > 50 ? "CLIENT (long tasks)"
      : networkMs > 50 ? "SERVER (request wait)"
        : "neither — under measurement floor";
  return {
    name, ackMs: null, settleMs, longTaskMs: Math.round(r.longTaskMs),
    worstLongTaskMs: Math.round(r.worst), networkMs, requests: r.fetches.length,
    attribution, note,
  };
}

async function login(page: Page): Promise<void> {
  const res = await page.context().request.post(`${BASE}/api/auth/login`, {
    data: { username: USER, password: PASS },
    headers: { "x-requested-with": "1" },
  });
  expect(res.ok(), `login as ${USER} must succeed`).toBe(true);
}

test("cockpit performance sweep", async ({ page }) => {
  test.setTimeout(Number(process.env["PERF_TIMEOUT_MS"] ?? 900_000));
  const report: Record<string, unknown> = { label: LABEL, base: BASE, at: new Date().toISOString() };

  /**
   * Persist after EVERY phase, not at the end.
   *
   * The first heavy-scale run died on the 600s cap partway through the last
   * phase and wrote nothing at all — ten minutes of real measurement thrown
   * away because the only write was the final one. At this scale a run that
   * does not finish is the normal case, not the exception, so the report has
   * to be durable as it goes. Phases already completed are findings; losing
   * them because a later phase was slow is just bad bookkeeping.
   */
  const save = (): void => {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n", "utf8");
  };

  await login(page);
  await page.addInitScript(INIT);

  // Seed the KEPT SELECTION the way the app itself persists it, so boot
  // restores a chosen conversation through the product's own §10 restore
  // path (probes.ts reads these atoms at module load) rather than through
  // some test-only back door. This is how the 20,000-message conversation
  // gets opened: as the conversation the user last had open.
  const MEGA = process.env["PERF_MEGA_CHAT"] ?? "";
  const MEGA_PROJECT = process.env["PERF_MEGA_PROJECT"] ?? "";
  if (MEGA !== "") {
    await page.addInitScript(
      ([chatId, projectId]: [string, string]) => {
        try {
          sessionStorage.setItem("bridlewise:currentChatId", chatId);
          localStorage.setItem("bridlewise:currentChatId", chatId);
          if (projectId !== "") {
            sessionStorage.setItem("bridlewise:currentProjectId", projectId);
            localStorage.setItem("bridlewise:currentProjectId", projectId);
          }
        } catch { /* storage disabled — the restore simply will not happen */ }
      },
      [MEGA, MEGA_PROJECT] as [string, string],
    );
  }

  // ── Boot ──
  const bootT0 = Date.now();
  await page.goto(COCKPIT, { waitUntil: "commit" });
  await page.waitForSelector(REVEALED, { timeout: 60_000 });
  report["bootWallMs"] = Date.now() - bootT0;
  report["frameClockMs"] = await assertFrameClock(page);
  save();
  await page.waitForTimeout(2500);

  report["boot"] = await page.evaluate(() => {
    const P = (window as any).__probe;
    const reveal = P.revealAt as number;
    const api = P.fetches.filter((f: any) => f.url.includes("/api/") && f.end !== null)
      .map((f: any) => ({ url: f.url.split("?")[0], start: +f.start.toFixed(1), end: +f.end.toFixed(1), dur: Math.round(f.end - f.start), bytes: f.bytes }))
      .sort((a: any, b: any) => a.start - b.start);
    const chain = api.filter((c: any) => c.start < reveal);
    const legs = [];
    for (let i = 1; i < chain.length; i += 1) {
      legs.push({ from: chain[i - 1].url, to: chain[i].url, gapMs: +(chain[i].start - chain[i - 1].end).toFixed(1), serial: chain[i].start >= chain[i - 1].end });
    }
    const res = performance.getEntriesByType("resource");
    const assets = res.filter((r: any) => !r.name.includes("/api/"));
    const lt = P.longTasks.filter((t: any) => t.start < reveal);
    return {
      revealMs: Math.round(reveal),
      chain, serialLegs: legs, allSerial: legs.every((l: any) => l.serial),
      longTaskMsBeforeReveal: Math.round(lt.reduce((s: number, t: any) => s + t.dur, 0)),
      afterReveal: api.filter((c: any) => c.start >= reveal),
      assets: { count: assets.length, wireBytes: assets.reduce((s: number, r: any) => s + (r.transferSize || 0), 0), decodedBytes: assets.reduce((s: number, r: any) => s + (r.decodedBodySize || 0), 0) },
      apiBytes: api.reduce((s: number, c: any) => s + (c.bytes || 0), 0),
      layoutShift: { count: P.shifts, value: +P.shiftValue.toFixed(5) },
    };
  });

  // ── Warm revisit ──
  const warmT0 = Date.now();
  await page.reload({ waitUntil: "commit" });
  await page.waitForSelector(REVEALED, { timeout: 60_000 });
  report["warmRevisitWallMs"] = Date.now() - warmT0;
  save();
  await page.waitForTimeout(1500);

  // ── The boot walk's drain — never measure a room open inside it ──
  // The reveal frame lands on the Switch, whose visibility arms ONE
  // /api/projects/<id>/chats read per project (once per session, capped at
  // FEED_CONCURRENCY in flight) — and the warm reload just above is a fresh
  // session, so this sweep's own boot armed the walk again. At the 10k-project
  // fixture that is ~2 requests in flight for ~109s (the e2e's own phase-7
  // witness: chatsFetches 10000, completionMs 108330), pressing on the API's
  // one event loop; run 3 measured custody's cold open inside it and
  // recorded the walk, not the room (cold AND warm ~15s at ~1400-1500
  // requests each — the same stuck first-open import timed out twice). Gate
  // the rooms phase on the walk's drain, exactly the e2e's own gate
  // (profile.spec.ts's feedActiveCount() === 0), so a cold open pays only
  // the first-open class the same run measured for editor (~0.2-2s).
  const feed = await page.evaluateHandle(() => {
    const path = "/src/cockpit/rooms/switch-feed.ts";
    return import(path) as Promise<typeof import("../../../src/cockpit/rooms/switch-feed.ts")>;
  });
  try {
    await page.waitForFunction(module => module.feedActiveCount() === 0, feed, { timeout: 240_000 });
  } finally { await feed.dispose(); }

  // ── Rooms: cold (first open, pays the dynamic import) then warm ──
  const rooms = ["switch", "instruments", "custody", "editor", "settings"] as const;
  const closeRoom = async (): Promise<void> => {
    const close = page.locator(`${ACTIVE_ROOM} button.close`).first();
    if (await close.count() > 0) { await close.click({ timeout: 2_000 }).catch(() => {}); await page.waitForTimeout(250); }
  };
  /** The desk's toggle opens the workspace INSPECTOR, and while the
   * inspector overlays, the desk-underlay that carries the toggle button is
   * INERT — the underlay's own button can never close what it opened. Close
   * through the inspector's own control instead, restoring the
   * closed-inspector precondition so every underlay click that follows
   * targets a live button. */
  const closeInspector = async (): Promise<void> => {
    const close = page.locator('[data-verb-id="right-menu.close"]').first();
    if (await close.count() > 0) {
      await close.click({ timeout: 2_000 }).catch(() => {});
      await page.waitForSelector("aside.right-menu", { state: "hidden", timeout: 5_000 }).catch(() => {});
    }
  };
  const coldRooms: Interaction[] = [];
  for (const id of rooms) {
    await closeRoom();
    coldRooms.push(await interact(page, `room:${id} (cold)`,
      async () => { await page.locator(`[data-chord-target="${id}"]`).first().click({ timeout: 2_000 }); },
      `${ACTIVE_ROOM}`));
  }
  const warmRooms: Interaction[] = [];
  for (const id of rooms) {
    await closeRoom();
    warmRooms.push(await interact(page, `room:${id} (warm)`,
      async () => { await page.locator(`[data-chord-target="${id}"]`).first().click({ timeout: 2_000 }); },
      `${ACTIVE_ROOM}`));
  }
  report["rooms"] = { cold: coldRooms, warm: warmRooms };
  save();

  // ── Desk ──
  // The desk's toggle now opens the workspace INSPECTOR, and while the
  // inspector overlays, the desk-underlay that carries the toggle button is
  // INERT — run 3's desk:close click never dispatched and, un-timed, waited
  // ~857s for a button that can never be clicked (the spec's own documented
  // hang class at the longSession note). Measure the CURRENT surface
  // honestly instead: every toggle click is bounded (:387's idiom), acks the
  // inspector itself, and is taken from the closed-inspector precondition —
  // restored through the inspector's own close control — so each click
  // targets a live button. What the underlay's button can never do (close
  // what it opened) goes through that control, and the block ends with the
  // precondition restored for the phases that follow.
  await closeRoom();
  await closeInspector();
  const desk: Interaction[] = [];
  desk.push(await interact(page, "desk: open",
    async () => { await page.locator('[data-verb-id="desk.toggle"]').first().click({ timeout: 2_000 }); },
    "aside.right-menu"));
  await closeInspector();
  desk.push(await interact(page, "desk: close",
    async () => { await page.locator('[data-verb-id="desk.toggle"]').first().click({ timeout: 2_000 }); },
    "aside.right-menu"));
  await closeInspector();
  report["desk"] = desk;
  save();

  // ── Switch room: the conversation list, and opening one ──
  await closeRoom();
  await page.locator('[data-chord-target="switch"]').first().click({ timeout: 2_000 });
  await page.waitForSelector(ACTIVE_ROOM, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  const switchStats = await page.evaluate(() => {
    const room = document.querySelector('section.room[data-room-active="true"]');
    return {
      domNodes: room ? room.querySelectorAll("*").length : 0,
      reels: document.querySelectorAll('[data-verb-id="switch.resume"]').length,
      scrollHeight: (document.querySelector(".river, .reel-list, .switch-body") as HTMLElement | null)?.scrollHeight ?? null,
    };
  });
  report["switch"] = switchStats;
  save();
  const resume = page.locator('[data-verb-id="switch.resume"]').first();
  if (await resume.count() > 0) {
    report["switchResume"] = await interact(page, "switch: open a conversation",
      async () => { await resume.click({ timeout: 2_000 }); }, null);
  }

  // ── Editor room: the file tree ──
  await closeRoom();
  await page.locator('[data-chord-target="editor"]').first().click({ timeout: 2_000 });
  await page.waitForSelector(ACTIVE_ROOM, { timeout: 15_000 });
  await page.waitForTimeout(2000);
  const treeStats = await page.evaluate(() => ({
    entries: document.querySelectorAll('[data-verb-id="editor.open-entry"]').length,
    domNodes: document.querySelector('section.room[data-room-active="true"]')?.querySelectorAll("*").length ?? 0,
  }));
  report["editorTree"] = treeStats;
  save();
  const entry = page.locator('[data-verb-id="editor.open-entry"]').first();
  if (await entry.count() > 0) {
    report["editorOpen"] = await interact(page, "editor: open first entry", async () => { await entry.click({ timeout: 2_000 }); }, null);
  }

  // ── Flow: expand a tool call / fold in place ──
  await closeRoom();
  await page.waitForTimeout(800);
  const fold = page.locator('[data-verb-id="flow.expand"]').first();
  if (await fold.count() > 0) {
    report["flowExpand"] = await interact(page, "flow: expand a fold", async () => { await fold.click({ timeout: 2_000 }); }, null);
  }
  save();
  report["flowStats"] = await page.evaluate(() => ({
    beats: document.querySelectorAll(".beat").length,
    domNodes: document.querySelectorAll("*").length,
    flowScrollHeight: (document.querySelector(".flow") as HTMLElement | null)?.scrollHeight ?? null,
  }));

  // ── Flow scroll: frame timing under scroll ──
  report["flowScroll"] = await page.evaluate(async () => {
    const el = document.querySelector(".flow") as HTMLElement | null;
    if (el === null) return { note: "no .flow" };
    const frames: number[] = [];
    let last = performance.now();
    let stop = false;
    const tick = (): void => { const n = performance.now(); frames.push(n - last); last = n; if (!stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const lt: number[] = [];
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push(e.duration); });
    po.observe({ type: "longtask" });
    for (let i = 0; i < 40; i += 1) {
      el.scrollTop += 400;
      await new Promise((r) => setTimeout(r, 25));
    }
    stop = true; po.disconnect();
    const sorted = frames.slice(2).sort((a, b) => a - b);
    const p = (q: number): number => sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(q / 100 * (sorted.length - 1)))]!.toFixed(1) : NaN;
    return {
      frames: sorted.length, p50: p(50), p95: p(95), p99: p(99), max: +(sorted[sorted.length - 1] ?? 0).toFixed(1),
      droppedOver32ms: sorted.filter((f) => f > 32).length,
      longTasks: lt.length, worstLongTaskMs: lt.length ? Math.round(Math.max(...lt)) : 0,
    };
  });

  save();

  // ── Long session: cycle rooms, watch the heap ──
  const heapOf = async (): Promise<{ heapMb: number; domNodes: number; listeners: number }> => {
    const cdp = await page.context().newCDPSession(page);
    const m = await cdp.send("Performance.getMetrics");
    const map = new Map((m.metrics ?? []).map((x) => [x.name, x.value]));
    await cdp.detach();
    return {
      heapMb: +(((map.get("JSHeapUsedSize") ?? 0) / 1048576).toFixed(2)),
      domNodes: map.get("Nodes") ?? 0,
      listeners: map.get("JSEventListeners") ?? 0,
    };
  };
  const before = await heapOf();
  const CYCLES = Number(process.env["PERF_CYCLES"] ?? 8);
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    for (const id of rooms) {
      // BOUNDED, or the catch below is unreachable: an OPEN room's cap covers
      // the horizon's room buttons, and with no action timeout a covered
      // click waits for the whole test budget — which is why no recorded run
      // ever carried a `longSession` key. The catch was always meant to
      // tolerate an unactionable click; the timeout is what makes it fire.
      await page.locator(`[data-chord-target="${id}"]`).first().click({ timeout: 2_000 }).catch(() => {});
      await page.waitForTimeout(90);
    }
    await closeRoom();
  }
  await page.waitForTimeout(1500);
  const after = await heapOf();
  report["longSession"] = {
    cycles: CYCLES, roomsPerCycle: rooms.length,
    before, after,
    heapGrowthMb: +(after.heapMb - before.heapMb).toFixed(2),
    domNodeGrowth: after.domNodes - before.domNodes,
    listenerGrowth: after.listeners - before.listeners,
  };

  save();
  console.log(`\n=== ${LABEL} ===\n` + JSON.stringify(report, null, 2));
});
