/**
 * Performance profile — the orchestration that drives `PerfHarness` across
 * the cockpit and writes a structured JSON report.
 *
 * Run it through the one step, `npm run perf:profile`
 * (scripts/testing/perf-profile.ts): inside the host's instrument lock it
 * prepares a fresh cockpit fixture, serves it on an isolated stack (the API
 * and vite on kernel-assigned ports, never the developer's servers or
 * stores) and runs this profile against it (`HARNESS_PERF_FIXTURE_PATH`,
 * `HARNESS_PERF_BASE_URL`). The workspace gate that runs the web suite
 * requires that step, so the regression gate always judges a report made
 * for the tree it judges.
 *
 * Output: `tests/performance/.report.json` (read by the vitest regression
 * test `tests/performance/regression.test.ts`).
 *
 * The profile is a single Playwright test (one browser, one server) so the
 * measurements share a single network observer + memory timeline. Every
 * profiled surface is DISCOVERED DYNAMICALLY (rooms from the room-file
 * convention `src/cockpit/rooms/<Id>Room.svelte`, interactive elements from
 * the DOM, API routes from the server source) — no hardcoded list that
 * could silently rot when a new room/button/route is added.
 *
 * Login is programmatic (direct HTTP, no navigation). Phases:
 *   1. API routes (isolated): scan `server/routes/*.ts` for every
 *      `router.METHOD(path)` + call each read-only route via direct HTTP,
 *      BEFORE the browser session starts. The server runs every request on
 *      one event loop, so a route timed during the session measures the
 *      session's contention, not the route (measured ~3000x inflation:
 *      `GET /api/health` reported 8562ms in-session vs ~2ms direct). The
 *      isolation evidence (page URL + browser API call count) is recorded
 *      in the report and asserted by the regression gate.
 *   2. Page-load metrics (LCP, FCP, TTFB, CLS, long tasks, CDP) — measured
 *      on the SECOND navigation: one un-measured warm-up load pays vite's
 *      cold on-demand compilation first, so the measured numbers are the
 *      app's, never the compiler's (measured across three rounds: cold LCP
 *      1988–4724ms vs ~600ms warm, identical code).
 *   3. Rooms: open every discovered room via its chord grip (the report's
 *      `tabs` population — the cockpit's room set IS its tab set).
 *   4. Interactions: composer typing, desk open/close. No scroll census is
 *      taken here — the clean-boot state has no conversation open (the
 *      flow has no content to overflow) and the real-population river has
 *      0px of travel; the flow's census lives in phase 6 over the seeded
 *      transcript, and the river's reading is retired (it does not
 *      overflow under any population the profile builds).
 *   5. Interactive elements: DOM-scan every button/input/menu item in each
 *      room + click a bounded non-mutating sample (INP).
 *   6. Real data — long chat: use 1000 messages prepared while stopped, restore the
 *      conversation through the product's own kept-selection path, profile
 *      the flow render + scroll.
 *   7. Real data — 10k projects: read the complete real project/chat population
 *      and profile boot, completion and the bounded switch river.
 *   8. Multi-viewport: desktop / tablet / mobile page-load + DOM metrics.
 *   9. Long session: rapid room cycling (leak detection).
 *  10. Build + write the structured report.
 *
 * @test-only
 */
import { test, expect, type Response } from "@playwright/test";
import { readdirSync, openSync, writeFileSync, closeSync } from "node:fs";
import { resolve } from "node:path";

import { readMeasuredSurfaceHash, readRepositoryHeadSha, readWorkingTreeDirty } from "../../engine/src/shared/tree-identity.ts";

import {
  PerfHarness,
  apiLogin,
  buildReport,
  writeReport,
  REPORT_PATH,
  round,
  discoverApiRoutesFromSource,
  profileApiRoutes,
  readPreparedProfileFixture,
  qualifyProjectRecovery,
  type ProfileReport,
  type TreeIdentity,
  type InteractiveProfile,
  type InteractionMeasurement,
  type DiscoveredRoute,
  type RouteProfile,
  type ViewportProfile,
} from "./lib/perf-harness";

// The stack the one profile step started (scripts/testing/perf-profile.ts): its port is the kernel's, read back.
const BASE = process.env["HARNESS_PERF_BASE_URL"] ?? (() => { throw new Error("set HARNESS_PERF_BASE_URL to the profiled stack's origin: run the profile through `npm run perf:profile`, which starts it"); })();
const USERNAME = "admin";
// The dev password comes from the environment ONLY (no literal in a tracked file).
const PASSWORD = process.env["HARNESS_WEB_AUTH_PASSWORD"] ?? (() => { throw new Error("set HARNESS_WEB_AUTH_PASSWORD to the profiled server's admin password (no built-in default)"); })();
// The server root for route-source discovery (relative to the web-UI repo).
const SERVER_ROOT = "server";

/** The cockpit's boot acknowledgement — the honest "usable" moment. */
const REVEALED = '.cockpit[data-revealed="true"]';
/** A room is on screen (rooms are kept alive and flipped, never unmounted). */
const ACTIVE_ROOM = 'section.room[data-room-active="true"]';

// Mutating/destructive-action label filter (deny-by-default for
// auto-clicks). A control whose label matches is DISCOVERED (reported in
// the inventory) but NOT auto-clicked — it could delete data, send a real
// message to the model, arm the sweep, or end the session. This is a fixed
// semantic classification of verbs, not a hardcoded list of items that
// could grow — a new read-only control is auto-profiled; a new mutating
// control is auto-skipped.
const MUTATING_LABEL_RE = /\b(delete|remove|destroy|drop|logout|log out|reset|clear|discard|trash|purge|sign out|send|save|create|new|arm)\b/i;

/** Rooms, discovered from the shell's own file convention: every
 * `src/cockpit/rooms/<Id>Room.svelte` is a room whose id is the lowercased
 * `<Id>` (the same 1:1 law `tests/cockpit/room-door-owner.test.ts` pins).
 * Reading the convention rather than a list means a new room file is
 * profiled without editing this spec. */
function discoverRooms(): readonly string[] {
  return readdirSync(resolve(import.meta.dirname, "../../src/cockpit/rooms"))
    .map((f) => /^([A-Za-z]+)Room\.svelte$/.exec(f)?.[1])
    .filter((id): id is string => id !== undefined)
    .map((id) => id.toLowerCase())
    .sort();
}

test("completed API timings retain request identity after navigation", async ({ page }, testInfo) => {
  const harness = new PerfHarness(page);
  const completed: number[] = [];
  const atHeaders: { responseMs: number; bytes: number }[] = [];
  const timings: ReturnType<import("@playwright/test").Request["timing"]>[] = [];
  const native: { method: string; status: number; traceId: string | null; observedAt: number }[] = [];
  const startedAt = Date.now();
  const responseSizes: Promise<number>[] = [];
  page.on("response", (response) => {
    if (response.url() === `${BASE}/api/health`) atHeaders.push(harness.getApiCalls().at(-1)!);
  });
  page.on("requestfinished", (request) => {
    if (request.url() !== `${BASE}/api/health`) return;
    const timing = request.timing();
    const response = request.existingResponse()!;
    native.push({ method: request.method(), status: response.status(), traceId: response.headers()["x-trace-id"] ?? null, observedAt: Date.now() });
    timings.push({ ...timing });
    completed.push(round(timing.responseEnd - timing.requestStart));
    responseSizes.push(request.sizes().then((sizes) => sizes.responseBodySize + sizes.responseHeadersSize));
  });
  await page.goto(`${BASE}/api/health`);
  const nextFinished = page.waitForEvent("requestfinished", (request) => request.url() === `${BASE}/api/health`);
  await page.evaluate(async () => { await fetch(location.href).then((response) => response.text()); });
  await nextFinished;
  // The new document has no Resource Timing entries for those requests.
  // Their completed measurements must stand in the owning collection.
  await page.goto("about:blank");
  await harness.finalizeNetwork();
  const calls = harness.getFinalizedNetwork().filter((call) => call.url === "/api/health");
  expect(calls, "two actual requests to one URL remain two measurements").toHaveLength(2);
  expect(completed.every(Number.isFinite), "the real browser measured both completions").toBe(true);
  expect(calls.map((call) => call.responseMs), "each row retains its own request's completed timing").toEqual(completed);
  expect(harness.networkSummary().maxResponseMs).toBe(Math.max(...completed));
  // A new document now has a Resource Timing entry for the SAME URL.
  // It must not replace all earlier measurements that happen to name it.
  await page.goto(`${BASE}/api/health`);
  const latestFinished = page.waitForEvent("requestfinished", (request) => request.url() === `${BASE}/api/health`);
  await page.evaluate(async () => { await fetch(location.href).then((response) => response.text()); });
  await latestFinished;
  // Exercise a real method refusal at the same URL. The native response is
  // the oracle: the test does not invent which status this server returns.
  const refusedFinished = page.waitForEvent("requestfinished", (request) => request.url() === `${BASE}/api/health` && request.method() === "POST");
  await page.evaluate(async () => { await fetch(location.href, { method: "POST" }).then((response) => response.text()); });
  await refusedFinished;
  await harness.finalizeNetwork();
  const repeated = harness.getFinalizedNetwork().filter((call) => call.url === "/api/health");
  expect(repeated, "a current document's URL twin cannot collapse the earlier requests").toHaveLength(5);
  expect(atHeaders).toHaveLength(5);
  expect(atHeaders.every((call) => Number.isNaN(call.responseMs) && Number.isNaN(call.bytes)), "headers do not establish completed timing or response size").toBe(true);
  expect(repeated.map((call) => call.responseMs)).toEqual(completed);
  expect(repeated.map((call) => call.bytes), "each response keeps its own encoded body and HTTP header size").toEqual(await Promise.all(responseSizes));
  expect(new Set(native.map((call) => call.method)).size, "the real population discriminates method provenance").toBeGreaterThan(1);
  expect(new Set(native.map((call) => call.status)).size, "the real population discriminates response provenance").toBeGreaterThan(1);
  expect(repeated.map((call) => call.method), "each row keeps its native Request method").toEqual(native.map((call) => call.method));
  expect(repeated.map((call) => call.status), "each row keeps its native Response status").toEqual(native.map((call) => call.status));
  expect(repeated.map((call) => call.timing), "native epoch and relative coordinates belong to the same request").toEqual(timings);
  expect(native.some((call) => call.traceId !== null), "the real server supplies trace linkage").toBe(true);
  expect(repeated.map((call) => call.traceId), "each row keeps its own server trace link").toEqual(native.map((call) => call.traceId));
  expect(repeated.every((call, index) => call.observedAt >= startedAt && call.observedAt <= native[index]!.observedAt), "callback wall-clock observations remain distinct from native request coordinates").toBe(true);
  expect(repeated.map((call) => call.fromCache), "cacheability cannot establish a cache hit").toEqual(native.map(() => null));
  expect(harness.networkSummary().cachedCount, "unknown cache provenance remains unknown in the report").toBeNull();
  expect(harness.networkSummary().maxResponseMs).toBe(Math.max(...completed));
  await testInfo.attach("completed-request-timings", { body: JSON.stringify({ native, timings, observed: repeated }), contentType: "application/json" });
});

test("a covered conversation cannot pass a scroll census", async ({ page }, testInfo) => {
  // Real browser hit testing distinguishes CSS-visible underlying rows
  // from a conversation the user can reach through a stale room overlay.
  await page.setContent('<div class="flow" style="height:200px;overflow:auto"><div style="height:4000px">conversation messages</div></div><section class="room" style="position:fixed;inset:0;background:white;z-index:10">restored editor room</section>');
  const harness = new PerfHarness(page);
  await harness.injectObservers();
  const covered = await harness.measureScrollLongTasks("covered-flow", ".flow", { stepPx: 120, travelPx: 1000, settleMs: 100 });
  expect(covered.ok).toBe(false);
  expect(covered.note).toContain('does not receive input at its visible center');
  expect(covered.scrolledPixels).toBe(0);
  await page.locator(".room").evaluate(node => node.remove());
  const revealed = await harness.measureScrollLongTasks("revealed-flow", ".flow", { stepPx: 120, travelPx: 1000, settleMs: 100 });
  expect(revealed.ok).toBe(true);
  expect(revealed.scrolledPixels).toBeGreaterThan(0);
  await testInfo.attach("scroll-surface-visibility", { body: JSON.stringify({ covered, revealed }), contentType: "application/json" });
});

test("profile the cockpit end to end", async ({ page, browserName }, testInfo) => {
  // The perf config runs chromium only (performance.memory and the CDP metrics): another browser here is a red, never a skip.
  expect(browserName, "the perf profile runs on chromium (performance.memory + CDP metrics)").toBe("chromium");
  test.setTimeout(900_000);
  const fixture = readPreparedProfileFixture(process.env["HARNESS_PERF_FIXTURE_PATH"]);
  const preparedProjectIds = new Set(fixture.projectIds), preparedChatIds = new Set(fixture.chatIds);
  const expectedMessageIds = [...fixture.longChat.messageIds].sort();
  // Phase stamps on stdout — when the run dies on the timeout, the log says
  // WHICH phase spent the budget instead of leaving a bare timeout.
  const runT0 = Date.now();
  const stamp = (name: string): void => {
    console.log(`[profile] ${name} at ${Math.round((Date.now() - runT0) / 1000)}s`);
  };

  await apiLogin(page, { baseURL: BASE, username: USERNAME, password: PASSWORD });

  const harness = new PerfHarness(page);
  await harness.initCdpEarly();

  // STALL EVIDENCE — when a reveal misses its bound, the run otherwise
  // says nothing about WHY (measured 2026-08-30: five consecutive 30s
  // reveal timeouts produced five bare ok:false rows). Keep a small ring
  // of page errors + console failures, and a live set of pending API
  // requests; each phase's diagnostic warn can then carry the page state
  // at the moment of the stall.
  const pageEvidence: string[] = [];
  page.on("pageerror", (err) => pageEvidence.push(`pageerror: ${String(err).slice(0, 200)}`));
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      pageEvidence.push(`console.${msg.type()}: ${msg.text().slice(0, 160)}`);
    }
  });
  const pendingApi = new Map<string, number>();
  const pendingAll = new Map<string, number>();
  page.on("request", (req) => {
    const key = req.method() + " " + req.url();
    pendingAll.set(key, Date.now());
    if (req.url().includes("/api/")) pendingApi.set(key, Date.now());
  });
  const dropPending = (req: { url: () => string; method: () => string }): void => {
    const key = req.method() + " " + req.url();
    pendingAll.delete(key);
    pendingApi.delete(key);
  };
  page.on("requestfinished", dropPending);
  page.on("requestfailed", dropPending);
  const failedResponses: string[] = [];
  page.on("response", (resp) => {
    if (resp.status() >= 400) {
      failedResponses.push(`http ${resp.status()} on ${resp.request().method()} ${resp.url().slice(0, 140)}`);
    }
  });
  const dumpStallEvidence = (): string => {
    const pendingLines = [...pendingAll.entries()]
      .map(([req, at]) => `  pending ${Date.now() - at}ms: ${req.slice(0, 140)}`)
      .slice(-12);
    const pageLines = pageEvidence.slice(-8).map((line) => `  page: ${line}`);
    const failedLines = failedResponses.slice(-6).map((line) => `  failed: ${line}`);
    return [...pageLines, ...failedLines, ...pendingLines].join("\n");
  };
  /** The page's own account of where boot stopped: rendered state, the
   *  registration lines already drawn, whether the live frame still turns,
   *  and every in-flight request (module fetches included — an /api/-only
   *  view hid exactly the class the stall needed once). */
  const probeStalledPage = async (): Promise<string> => {
    try {
      const rafOK = await Promise.race([
        page.evaluate(() => new Promise((res) => requestAnimationFrame(() => res("fires")))),
        new Promise<string>((res) => setTimeout(() => res("SILENT over 5s"), 5000)),
      ]);
      const state = await page.evaluate(() => ({
        cockpitPresent: document.querySelector(".cockpit") !== null,
        revealed: document.querySelector(".cockpit")?.getAttribute("data-revealed"),
        authed: document.querySelector(".cockpit")?.getAttribute("data-authed"),
        pendingPerformanceResources: performance
          .getEntriesByType("resource")
          .filter((e) => (e as PerformanceResourceTiming).responseEnd === 0)
          .map((e) => e.name.slice(0, 120))
          .slice(0, 12),
        bodyText: document.body.innerText.slice(0, 300),
      }));
      return `  rAF ${rafOK}\n  state: ${JSON.stringify(state).slice(0, 600)}`;
    } catch (err) {
      return `  probe itself failed: ${String(err).slice(0, 120)}`;
    }
  };

  const rooms = discoverRooms();
  const closeRoom = async (): Promise<void> => {
    const close = page.locator(`${ACTIVE_ROOM} button.close`).first();
    if (await close.count() > 0) {
      await close.click({ timeout: 3000 });
      await page.locator(ACTIVE_ROOM).waitFor({ state: "hidden", timeout: 3000 });
    }
  };

  // ── Phase 1: API routes (isolated — before the browser session) ──
  stamp("phase 1: api routes (isolated)");
  // Time every discovered read-only route via DIRECT HTTP calls (the API
  // request context — no page navigation, no browser traffic) BEFORE the
  // browser session starts. A route timed during the session measures the
  // neighbours, not the route: the server runs every request on one event
  // loop, and the session's page loads + SSE streams + background reads
  // inflate a sub-millisecond route to seconds (measured ~3000x on the
  // in-session profile: GET /api/health reported 8562ms; the same route
  // answers in ~2ms via a direct call). Before `page.goto` the server is
  // idle, so the timing is the route's own. The isolation evidence captured
  // below is recorded in the report + asserted by the regression gate — it
  // is what proves the numbers came from this quiet window.
  // Real ids for route-param resolution, read from the API itself (direct
  // HTTP — these calls also stay out of the browser's network log).
  let projectId = "";
  let chatId = "";
  try {
    const projectsResp = await page.context().request.get(`${BASE}/api/projects`, { headers: { "x-requested-with": "1" } });
    if (projectsResp.ok()) {
      const projectsJson = (await projectsResp.json()) as readonly { id: string }[];
      if (projectsJson.length > 0) projectId = projectsJson[0]!.id;
    }
    if (projectId !== "") {
      const chatsResp = await page.context().request.get(`${BASE}/api/projects/${projectId}/chats`, { headers: { "x-requested-with": "1" } });
      if (chatsResp.ok()) {
        const chatsJson = (await chatsResp.json()) as readonly { id: string }[];
        if (chatsJson.length > 0) chatId = chatsJson[0]!.id;
      }
    }
  } catch {
    // Absence is recorded below — the samples fall back to placeholders.
  }
  let discoveredRoutes: DiscoveredRoute[] = [];
  let routeProfiles: RouteProfile[] = [];
  try {
    discoveredRoutes = await discoverApiRoutesFromSource(SERVER_ROOT);
    routeProfiles = await profileApiRoutes(page, discoveredRoutes, {
      baseURL: BASE,
      samples: { projectId: projectId || "perf-sample", chatId: chatId || "perf-sample", eventId: "perf-sample" },
    });
  } catch {
    // Discovery failure is non-fatal — the report records the empty set.
  }
  // Isolation evidence: the page has never navigated (`about:blank`) and the
  // network observer has captured zero browser-driven API calls. The API
  // request context does not fire the page's response listener, so the route
  // calls above keep both values honest.
  const routeIsolation = {
    pageUrl: page.url(),
    browserApiCallsAtMeasure: harness.getApiCalls().length,
  };

  // ── Phase 2: Page load (measured — after ONE un-measured warm-up) ──
  stamp("phase 2: page load (warm-up, then measured)");
  await page.context().addInitScript(() => {
    (window as { __perf?: Record<string, number> }).__perf = {
      lcp: NaN, fcp: NaN, ttfb: NaN, cls: 0, clsEntries: 0,
      longTaskTotalMs: 0, longTaskCount: 0, longTaskWorstMs: 0,
      inpMs: 0, eventCount: 0,
    };
  });
  // THE COLD-VITE WARM-UP — one UN-MEASURED load that triggers the
  // compilation, then the measured loads. The first navigation after a
  // dev-server restart pays vite's cold on-demand compilation of the whole
  // shell, and the measured-across-three-rounds false reds were exactly
  // that compile being judged as the app: the SAME tree read 1988–4724ms
  // cold on LCP against ~600ms warm, reding phase 2's budget (1500ms) on
  // code nobody had changed. The warm-up load's own vitals are deliberately
  // never read (its LCP is the compiler's number, not the app's); what is
  // recorded is its wall time, as the report's evidence that the measured
  // load below ran over an already-compiled module graph. The budget still
  // asserts on the MEASURED load — a real regression in the shell's load
  // path still reds the gate, warm-up or no warm-up.
  const warmUpT0 = Date.now();
  await page.goto(BASE, { waitUntil: "commit" });
  // Generous on purpose: this load absorbs the ENTIRE cold compile, which
  // is the one cost this pass exists to pay.
  await page.waitForSelector(REVEALED, { timeout: 60_000 });
  const warmUpWallMs = Date.now() - warmUpT0;
  // THE WARM-UP MUST NOT REDEFINE WHAT IS MEASURED. The warm-up load is a
  // real boot, and a real boot PERSISTS state (the adopted project/chat
  // selection, the projects revisit cache). A reload that restores that
  // footprint is a DIFFERENT scenario than the clean boot the page-load
  // budgets were derived on — driven here to separate the two: a reload
  // over the warm-up's persisted footprint measured CLS 0.087–0.109 (the
  // revisit cache serves a stale-order optimistic fill that RE-SORTS when
  // the wire answers — the exact shift class the CLS budget's own history
  // is about), while the same reload over a cleared footprint measured
  // 0.0017. So the warm-up clears the keys it persisted — the profile's
  // own canonical cleanup set, the one phases 6 and 7 use — restoring the
  // clean-boot parity the budget asserts on. The budgets still assert on
  // the measured load, unweakened: this only removes the warm-up's own
  // side effect, not an arm.
  await page.evaluate(() => {
    sessionStorage.removeItem("bridlewise:workspaces");
    sessionStorage.removeItem("bridlewise:workspaces:active");
    sessionStorage.removeItem("bridlewise:currentChatId");
    localStorage.removeItem("bridlewise:currentChatId");
    sessionStorage.removeItem("bridlewise:currentProjectId");
    localStorage.removeItem("bridlewise:currentProjectId");
    localStorage.removeItem("bridlewise:projects:lastKnown");
  }).catch(() => {});
  // The measured load: a fresh navigation whose module graph is compiled.
  // "commit", never "networkidle": the cockpit holds the liveness SSE
  // stream open from boot, so the network is never idle by design — the
  // reveal flag is the honest "loaded" signal.
  await page.reload({ waitUntil: "commit" });
  await page.waitForSelector(REVEALED, { timeout: 20_000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  await harness.injectObservers();
  await page.waitForTimeout(800);

  const pageLoad = await harness.readWebVitals();
  const cdpAtLoad = await harness.readCdpMetrics();
  await harness.snapshotMemory("after-load");

  // ── Phase 3: Rooms — the cockpit's "tab" population ──
  stamp("phase 3: rooms");
  // Warm-up pass first: a room's FIRST open pays its dynamic import (and,
  // under the dev server, its on-demand transform) — a one-time boot cost,
  // not the switch latency `tabSwitchMaxMs` bounds. Rooms are kept alive
  // and flipped, so the measured pass below is the steady-state switch —
  // the same population the old shell's tab metric measured (one bundle,
  // no per-tab import). The cold/warm split itself is profiled separately
  // by tests/performance/cockpit/cockpit-perf.spec.ts.
  for (const id of rooms) {
    await closeRoom();
    await harness.measureRoomOpen(id);
  }
  await closeRoom();
  const tabResults: Array<ProfileReport["tabs"][number]> = [];
  for (const id of rooms) {
    await closeRoom();
    const r = await harness.measureRoomOpen(id);
    await harness.snapshotMemory(`room-${id}`);
    tabResults.push(r);
  }
  await closeRoom();

  // ── Phase 4: Interactions (curated) ──
  stamp("phase 4: interactions");
  const interactions: InteractionMeasurement[] = [];
  // Composer typing — the desk bar's input is always on screen. The text is
  // never SENT (send is a separate, filtered control) and the field is
  // cleared afterwards so no later click can submit it.
  interactions.push(
    await harness.measureTyping('[aria-label="composer"]', "perf test 123 456 789", "chat-input-typing"),
  );
  await page.locator('[aria-label="composer"]').first().fill("").catch(() => {});
  // Desk open + close (the most frequently animated surface). The bracket
  // acknowledges the state the toggle actually produces — the workspace
  // INSPECTOR the desk toggle now mounts APPEARING for the open, GOING AWAY
  // for the close — from a KNOWN state: the surface is settled closed
  // first, so each measurement proves a render instead of closing on a wait
  // target that pre-exists the click (the old close waited on the composer,
  // which is always visible — the number was the dispatch, not the close).
  // The old ack `.desk .panel` matched nothing in the current tree (the
  // desk→inspector rework: DeskPanel renders `.desk-panel` inside the
  // inspector host `aside.right-menu`), so run 3's open timed out its 8s
  // window BY CONSTRUCTION and the close refused "already hidden before the
  // click" — the ack now names the inspector container the toggle mounts.
  // The settle gesture is the inspector's own close control: while the
  // inspector overlays, the desk-underlay that carries the toggle is inert,
  // so the toggle itself can never close what it opened. The close
  // measurement keeps the toggle's own click and records the honest refusal
  // when that click cannot dispatch.
  if (await page.locator("aside.right-menu").first().isVisible().catch(() => false)) {
    await page.locator('[data-verb-id="right-menu.close"]').first().click({ timeout: 5000 }).catch(() => {});
    await page.locator("aside.right-menu").first().waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(200);
  }
  interactions.push(await harness.measureClick(
    '[data-verb-id="desk.toggle"]',
    "aside.right-menu",
    "desk-toggle-open",
  ));
  interactions.push(await harness.measureClick(
    '[data-verb-id="desk.toggle"]',
    "aside.right-menu",
    "desk-toggle-close",
    { waitState: "hidden" },
  ));

  // No scroll census is taken at phase 4, and the read-back proved why: the
  // clean-boot state this phase measures has NO conversation open, so the
  // flow has no content to overflow (live-measured 2026-09-02: the flow
  // probe refused with "no scrollable container"), and the real-population
  // river has 0px of travel (scrollHeight 984 == clientHeight 984). The
  // old probes scrolled both anyway and reported ok:true durationMs:0 —
  // the measured-nothing pass this round exists to end. The flow's census
  // is taken in phase 6 over the seeded 1000-message transcript, where
  // the flow provably scrolls; the river does not overflow under ANY
  // population the profile builds (the 10k mock 404s every synthetic
  // chats read, so no cap group ever renders and the river stays one
  // fold tall) — that reading is retired rather than faked.

  // ── Phase 5: Interactive elements — dynamic discovery + profiling ──
  stamp("phase 5: interactive elements");
  // Scan the DOM in each room for every interactive element (deny-by-
  // default: a newly added control is auto-discovered). Profile a bounded
  // sample of visible + non-mutating elements per room (the click can open
  // menus/sheets; Escape dismisses them) to keep the run bounded.
  const interactiveProfiles: InteractiveProfile[] = [];
  const MAX_CLICKS_PER_ROOM = 6;
  // THE CLOSED-INSPECTOR PRECONDITION, SETTLED BEFORE THE FIRST ROOM'S
  // SCAN. The phase-4 desk measurements end with desk-toggle-close
  // honestly refused — while the inspector overlays, the desk-underlay
  // that carries the toggle is inert, so the toggle itself can never
  // close what it opened — so the INSPECTOR IS STILL OPEN entering this
  // phase. The discovery scan is DOCUMENT-WIDE, so the first room's
  // census would collect the open inspector's controls ("Files",
  // "Changes", the inspector's own close, the Setup/Activity/Watches
  // tabs), and the first profiled click ("Files") opens its room through
  // the inspector's visitRoom → onClose(), DISMISSING the inspector
  // under the next five discovered elements — whose
  // scrollIntoViewIfNeeded then refuses its 2000ms window. That is the
  // run-3/run-4 shape (exactly five refused rows, "Changes" first) the
  // adjudication classified as a measurement-design artifact, not a
  // product regression: the census met the inert-underlay product fact
  // unprepared (docs/findings/recovery/records/
  // gate-budget-reds-adjudication.md, BUDGET-4). The same bounded settle
  // gesture phase 4 uses at its desk pair — close through the
  // inspector's own control, wait for the hidden state — establishes
  // that the census measures reachable surfaces only. The controls
  // remain reachable through their real path (desk.toggle → inspector →
  // Changes) and are re-discovered whenever a phase-5 click legitimately
  // opens the inspector again; what ends here is the census sequencing
  // itself dismissing surfaces mid-measurement.
  if (await page.locator("aside.right-menu").first().isVisible().catch(() => false)) {
    await page.locator('[data-verb-id="right-menu.close"]').first().click({ timeout: 5000 }).catch(() => {});
    await page.locator("aside.right-menu").first().waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(200);
  }
  for (const id of rooms.slice(0, 6)) {
    await closeRoom();
    await harness.measureRoomOpen(id);
    const elements = await harness.discoverInteractiveElements();
    let clicked = 0;
    for (const el of elements) {
      if (clicked >= MAX_CLICKS_PER_ROOM) break;
      if (!el.visible) continue;
      if (MUTATING_LABEL_RE.test(el.label)) continue;
      // Skip navigational links (already covered by the room phase).
      if (el.tag === "a") continue;
      const profile = await harness.profileInteraction(el);
      interactiveProfiles.push(profile);
      // Dismiss any menu/sheet the click opened.
      await page.keyboard.press("Escape").catch(() => {});
      clicked++;
    }
  }
  await closeRoom();

  // ── Phase 6: Real data — long chat (1000 messages) ──
  stamp("phase 6: long chat");
  // Restore the existing chat prepared and closed before service launch
  // through the product's own kept-selection path (the storage keys the
  // cockpit's §10 restore reads at boot) and measure the flow render +
  // scroll latency.
  const evidencePath = testInfo.outputPath("real-populations.jsonl");
  const evidenceFd = openSync(evidencePath, "wx");
  const recordPopulation = (value: unknown): void => { writeFileSync(evidenceFd, JSON.stringify(value) + "\n"); };
  let longChatResult: ProfileReport["realData"]["longChat"] = {
    visibleConversation: false, inputScrollPixels: 0,
    messageCount: 0, loadedMessages: 0, wireMessages: 0, populationMatches: false, renderMs: NaN, domNodes: NaN,
    scroll: { longTaskTotalMs: NaN, longTaskCount: NaN, longTaskWorstMs: NaN, scrolledPixels: 0, ok: false, note: "the phase did not run" },
    ok: false,
  };
  const longChatId = fixture.longChat.chatId;
  const historyIds = new Set<string>();
  const historyBodies = new Set<Promise<void>>();
  let historyError: unknown;
  let serverMessageCount = 0;
  const historyResponse = (response: Response): void => {
    if (!response.url().startsWith(`${BASE}/api/chats/${longChatId}/history`)) return;
    const pending = (async () => {
      const body = await response.json() as { messages: { id: string }[]; page: { messageCount: number } };
      recordPopulation({ phase: "long-chat", url: response.url(), status: response.status(), body });
      expect(response.status()).toBe(200);
      expect(body.page.messageCount).toBe(1000);
      serverMessageCount = body.page.messageCount;
      for (const message of body.messages) historyIds.add(message.id);
    })().catch(error => { historyError = error; recordPopulation({ phase: "long-chat-failure", message: String(error) }); });
    historyBodies.add(pending);
    void pending.finally(() => historyBodies.delete(pending));
  };
  try {
    // The preceding interactive inventory can leave another family open.
    // Use the real Chat door before saving/restoring the selected chat.
    await page.locator('[data-chord-target="editor"]').first().click();
    await expect(page.locator(ACTIVE_ROOM)).toHaveAttribute("aria-label", "editor room");
    recordPopulation({ phase: "long-chat-stale-room-witness", activeRoom: await page.locator(ACTIVE_ROOM).getAttribute("aria-label") });
    await page.locator('[data-chord-target="chat"]').first().click();
    await page.locator(ACTIVE_ROOM).waitFor({ state: "hidden" });
    // Use the product's actual kept-workspace restore. The connection that
    // prepared this chat was closed before the serving process started.
    await page.evaluate(([cid, pid]: [string, string]) => {
      const workspaceId = "perf-long-chat";
      sessionStorage.setItem("bridlewise:workspaces", JSON.stringify([{ id: workspaceId, projectId: pid, chatId: cid, openedAtMs: Date.now() }]));
      sessionStorage.setItem("bridlewise:workspaces:active", workspaceId);
      for (const [key, value] of [["currentChatId", cid], ["currentProjectId", pid]]) {
        sessionStorage.setItem(`bridlewise:${key}`, value!);
        localStorage.setItem(`bridlewise:${key}`, value!);
      }
    }, [longChatId, fixture.longChat.projectId]);
    // End the prior document before observing this phase, so canceled old
    // response bodies cannot be attributed to the new population.
    await page.goto("about:blank", { waitUntil: "commit" });
    page.on("response", historyResponse);
    const t0 = Date.now();
    await page.goto(BASE, { waitUntil: "commit" });
    await page.waitForSelector(REVEALED, { timeout: 30_000 });
    const chatControl = page.locator('[data-chord-target="chat"]').first();
    await chatControl.click();
    await expect(chatControl).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(ACTIVE_ROOM)).toHaveCount(0);
    await page.waitForSelector(".beat", { state: "visible", timeout: 20_000 });
    const flow = page.locator(".flow");
    await flow.click({ trial: true, timeout: 5000 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
    const renderMs = Date.now() - t0;
    await harness.injectObservers();
    const domNodes = await page.evaluate(() => document.querySelectorAll("*").length);
    const beatCount = await page.locator(".beat").count();
    const reach = await page.evaluateHandle(() => {
      const path = "/src/state/chat-history-reach.ts";
      return import(path) as Promise<typeof import("../../src/state/chat-history-reach.ts")>;
    });
    try {
      for (let pages = 0; pages < 1000; pages++) {
        const before = await reach.evaluate(module => module.historyReach.get());
        expect(before?.chatId).toBe(longChatId);
        expect(before?.failure).toBeNull();
        if (!before!.hasOlder) break;
        // Actual scroll delivery invokes Flow's older-page owner and its
        // anchoring; the observer never directly writes the transcript.
        await flow.hover();
        await page.mouse.wheel(0, -await flow.evaluate(node => node.scrollHeight));
        await page.waitForFunction(({ module, loaded }) => {
          const value = module.historyReach.get();
          return value !== null && (value.loaded > loaded || !value.hasOlder || value.failure !== null);
        }, { module: reach, loaded: before!.loaded }, { timeout: 30_000 });
      }
      const finalReach = await reach.evaluate(module => module.historyReach.get());
      await Promise.allSettled(historyBodies);
      if (historyError) throw historyError;
      expect(finalReach?.hasOlder).toBe(false);
      expect(finalReach?.loaded).toBe(1000);
      expect(finalReach?.messageCount).toBe(1000);
      const ingestedIds = await page.evaluate(async () => {
        const path = "/src/state/chat-messages.ts";
        const module = await import(path) as typeof import("../../src/state/chat-messages.ts");
        return module.messages.get().map(message => message.id);
      });
      expect([...historyIds].sort()).toEqual(expectedMessageIds);
      expect(ingestedIds.sort()).toEqual(expectedMessageIds);
      await page.getByText("the beginning of this conversation", { exact: true }).waitFor();
      await flow.click({ trial: true, timeout: 5000 });
      const inputStart = await flow.evaluate(node => node.scrollTop);
      await flow.hover();
      await page.mouse.wheel(0, 960);
      await expect.poll(() => flow.evaluate(node => node.scrollTop), { message: "visible Flow must receive an actual wheel input" }).toBeGreaterThan(inputStart);
      const inputScrollPixels = await flow.evaluate(node => node.scrollTop) - inputStart;
      const scroll = await harness.measureScrollLongTasks("long-chat-flow-scroll", ".flow", { stepPx: 480, travelPx: 20000, settleMs: 800 });
      await expect(chatControl).toHaveAttribute("aria-selected", "true");
      await expect(page.locator(ACTIVE_ROOM)).toHaveCount(0);
      longChatResult = { visibleConversation: true, inputScrollPixels, messageCount: serverMessageCount, loadedMessages: finalReach!.loaded, wireMessages: historyIds.size, populationMatches: true, renderMs: round(renderMs), domNodes, scroll, ok: beatCount > 0 && scroll.ok };
      recordPopulation({ phase: "long-chat-completed", result: longChatResult, ingestedIds, reach: finalReach });
      await page.screenshot({ path: testInfo.outputPath("long-chat.png") });
    } finally { await reach.dispose(); }
  } catch (error) {
    console.warn("[profile] long chat failed:", error);
    recordPopulation({ phase: "long-chat-refused", message: String(error), wireMessages: historyIds.size });
  } finally {
    page.off("response", historyResponse);
    await Promise.allSettled(historyBodies);
    // Clear only this browser's selection. The prepared chat remains part
    // of the fixture population until the stopped fixture lifecycle ends.
    await page.evaluate(() => {
      for (const key of ["workspaces", "workspaces:active", "currentChatId", "currentProjectId"]) sessionStorage.removeItem(`bridlewise:${key}`);
      localStorage.removeItem("bridlewise:currentChatId");
      localStorage.removeItem("bridlewise:currentProjectId");
    }).catch(() => {});
  }

  // ── Phase 7: Real data — complete project/chat population ──
  stamp("phase 7: complete real 10k projects");
  let manyProjectsResult: ProfileReport["realData"]["manyProjects"] = {
    retriedProjectIds: [],
    projectCount: 0, completedProjects: 0, loadedProjects: 0, chatCount: 0,
    mountedCaps: 0, mountedReels: 0, populationMatches: false, completionMs: NaN,
    renderMs: NaN, ok: false, chatsFetches: 0, maxChatsInFlight: 0,
  };
  const projectBodies = new Set<Promise<void>>();
  const completedProjects = new Set<string>(), wireChats = new Set<string>();
  const failedProjectRequests: { projectId: string; url: string; method: string; errorText: string | null; at: number }[] = [];
  const projectRequests: string[] = [];
  const projectRequest = (request: import("@playwright/test").Request): void => {
    if (request.method() === "GET" && /^\/api\/projects\/[^/]+\/chats$/.test(new URL(request.url()).pathname)) projectRequests.push(request.url());
  };
  const projectFailure = (request: import("@playwright/test").Request): void => {
    const match = /^\/api\/projects\/([^/]+)\/chats$/.exec(new URL(request.url()).pathname);
    if (request.method() !== "GET" || match === null) return;
    const failure = { projectId: match[1]!, url: request.url(), method: request.method(), errorText: request.failure()?.errorText ?? null, at: Date.now() };
    failedProjectRequests.push(failure);
    recordPopulation({ phase: "many-projects-request-failed", ...failure });
  };
  let wireProjects: string[] | undefined, populationError: unknown;
  const populationResponse = (response: Response): void => {
    const url = new URL(response.url());
    const match = /^\/api\/projects\/([^/]+)\/chats$/.exec(url.pathname);
    if (response.request().method() !== "GET" || (url.pathname !== "/api/projects" && match === null)) return;
    const pending = (async () => {
      const body = await response.json() as { id: string; projectId?: string }[];
      recordPopulation({ phase: "many-projects", url: response.url(), status: response.status(), body });
      if (response.status() !== 200) throw new Error(`project population HTTP ${response.status()}: ${response.url()}`);
      if (match === null) wireProjects = body.map(project => project.id);
      else {
        for (const chat of body) { if (chat.projectId !== match[1]) throw new Error(`chat ${chat.id} belongs to another project`); wireChats.add(chat.id); }
        completedProjects.add(match[1]!);
      }
    })().catch(error => { populationError = error; recordPopulation({ phase: "many-projects-failure", message: String(error) }); });
    projectBodies.add(pending);
    void pending.finally(() => projectBodies.delete(pending));
  };
  const feedReads = await harness.instrumentFeedChatsReads();
  // Bind the actual current population after all earlier phases. Additional
  // real records remain in the expected set; no synthetic response or cap.
  const currentProjectsResponse = await page.context().request.get(`${BASE}/api/projects`);
  expect(currentProjectsResponse.status()).toBe(200);
  const expectedProjects = ((await currentProjectsResponse.json()) as { id: string }[]).map(project => project.id);
  const expectedSet = new Set(expectedProjects);
  expect(fixture.projectIds.every(id => expectedSet.has(id))).toBe(true);
  try {
    await page.goto("about:blank", { waitUntil: "commit" });
    page.on("response", populationResponse);
    page.on("request", projectRequest);
    page.on("requestfailed", projectFailure);
    const t0 = Date.now();
    await page.goto(BASE, { waitUntil: "commit" });
    await page.waitForSelector(REVEALED, { timeout: 30_000 });
    await harness.injectObservers();
    await page.waitForSelector(`${ACTIVE_ROOM} .river`, { state: "visible", timeout: 15_000 });
    await page.waitForSelector(`${ACTIVE_ROOM} .river .fold, ${ACTIVE_ROOM} .river .group`, { timeout: 15_000 });
    const renderMs = Date.now() - t0;
    const feed = await page.evaluateHandle(() => {
      const path = "/src/cockpit/rooms/switch-feed.ts";
      return import(path) as Promise<typeof import("../../src/cockpit/rooms/switch-feed.ts")>;
    });
    let loadedProjects: string[];
    try {
      await page.waitForFunction(module => module.feedActiveCount() === 0, feed, { timeout: 240_000 });
      await Promise.allSettled(projectBodies);
      if (populationError) throw populationError;
      const failed = await feed.evaluate(module => [...module.chatsStates].filter(([, state]) => state === "failed").map(([id]) => id));
      if (failed.length > 0) {
        // Recovery uses the existing user door once, for the exact failed
        // transport population. A missing body/ingestion result without
        // that evidence remains a refusal, never an assumed retry.
        qualifyProjectRecovery(expectedSet, completedProjects, failed, failedProjectRequests);
        recordPopulation({ phase: "many-projects-before-recovery", failedProjectIds: failed, completedProjects: completedProjects.size, failures: failedProjectRequests });
        const requestStart = projectRequests.length;
        manyProjectsResult = { ...manyProjectsResult, retriedProjectIds: failed };
        await closeRoom();
        await page.keyboard.press("Control+j");
        await page.locator('section.room[aria-label="switch room"][data-room-active="true"]').waitFor();
        await page.waitForFunction(module => module.feedActiveCount() === 0, feed, { timeout: 60_000 });
        await Promise.allSettled(projectBodies);
        if (populationError) throw populationError;
        const retried = projectRequests.slice(requestStart);
        recordPopulation({ phase: "many-projects-recovery", attempt: 1, failedProjectIds: failed, retried, completedProjects: completedProjects.size });
        expect(retried.sort(), "the real close/reopen must retry only the failed project URLs").toEqual(failed.map(id => `${BASE}/api/projects/${id}/chats`).sort());
      }
      loadedProjects = await feed.evaluate(module => [...module.chatsStates].filter(([, state]) => state === "loaded").map(([id]) => id));
    } finally { await feed.dispose(); }
    await Promise.allSettled(projectBodies);
    if (populationError) throw populationError;
    const state = await page.evaluate(async () => {
      const path = "/src/state/chats.ts";
      const module = await import(path) as typeof import("../../src/state/chats.ts");
      return { ids: module.chatsSnapshot().map(chat => chat.id), mountedCaps: document.querySelectorAll(".switch .group").length, mountedReels: document.querySelectorAll(".switch .reel").length };
    });
    const fanOut = await feedReads.read();
    manyProjectsResult = { ...manyProjectsResult, projectCount: expectedProjects.length, completedProjects: completedProjects.size, loadedProjects: loadedProjects.length, chatCount: state.ids.length, mountedCaps: state.mountedCaps, mountedReels: state.mountedReels, completionMs: round(Date.now() - t0), renderMs: round(renderMs), chatsFetches: fanOut.total, maxChatsInFlight: fanOut.peak };
    recordPopulation({ phase: "many-projects-observed", result: manyProjectsResult, loadedProjectIds: loadedProjects, ingestedChatIds: state.ids });
    const sortedExpected = expectedProjects.sort();
    expect(wireProjects?.sort()).toEqual(sortedExpected);
    expect([...completedProjects].sort()).toEqual(sortedExpected);
    expect(loadedProjects.sort()).toEqual(sortedExpected);
    expect(state.ids.sort()).toEqual([...wireChats].sort());
    expect(fixture.chatIds.every(id => wireChats.has(id))).toBe(true);
    manyProjectsResult = { ...manyProjectsResult, populationMatches: true, ok: true };
    recordPopulation({ phase: "many-projects-completed", result: manyProjectsResult, projectIds: expectedProjects, chatIds: state.ids, additionalProjectIds: expectedProjects.filter(id => !preparedProjectIds.has(id)), additionalChatIds: state.ids.filter(id => !preparedChatIds.has(id)) });
    await page.screenshot({ path: testInfo.outputPath("many-projects.png") });
    await closeRoom();
  } catch (error) {
    console.warn("[profile] real 10k projects failed:", error);
    console.warn(`[profile] stall evidence at real 10k boot:\n${dumpStallEvidence()}`);
    const fanOut = await feedReads.read().catch(() => ({ total: 0, peak: 0 }));
    manyProjectsResult = { ...manyProjectsResult, projectCount: wireProjects?.length ?? 0, completedProjects: completedProjects.size, chatCount: wireChats.size, chatsFetches: fanOut.total, maxChatsInFlight: fanOut.peak };
    recordPopulation({ phase: "many-projects-refused", result: manyProjectsResult, message: String(error) });
  } finally {
    page.off("response", populationResponse);
    page.off("request", projectRequest);
    page.off("requestfailed", projectFailure);
    await Promise.allSettled(projectBodies);
    await feedReads.uninstall();
    closeSync(evidenceFd);
    await testInfo.attach("real-population-evidence", { path: evidencePath, contentType: "application/x-ndjson" });
  }

  // ── Phase 8: Multi-viewport (desktop / tablet / mobile) ──
  stamp("phase 8: viewports");
  const viewportProfiles: ViewportProfile[] = [];
  const viewports = [
    { name: "desktop", width: 1280, height: 720 },
    { name: "tablet", width: 768, height: 1024 },
    { name: "mobile", width: 375, height: 667 },
  ];
  for (const vp of viewports) {
    try {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(500);
      await harness.resetCounters();
      await page.reload({ waitUntil: "commit" });
      await page.waitForSelector(REVEALED, { timeout: 30_000 });
      // Re-inject the web-vitals observers after the reload (the reload
      // re-creates the document; `addInitScript` seeds `window.__perf`, but
      // the PerformanceObservers must be re-created in the new document).
      await harness.injectObservers();
      await page.waitForTimeout(800);
      const vitals = await harness.readWebVitals();
      const domNodes = await page.evaluate(() => document.querySelectorAll("*").length);
      viewportProfiles.push({
        name: vp.name, width: vp.width, height: vp.height,
        lcp: vitals.lcp, cls: vitals.cls, longTaskWorstMs: vitals.longTaskWorstMs,
        domNodes,
        // The precondition verdict only: LCP was measured and the census
        // was live. Budget judgment (LCP, worst long task) is the gate's.
        ok: Number.isFinite(vitals.lcp) && Number.isFinite(vitals.longTaskWorstMs),
      });
    } catch (err) {
      // The ok:false row is the report's answer; the CAUSE rides stdout, or a
      // timed-out waitForSelector is indistinguishable from a dead probe.
      console.warn(`[profile] viewport ${vp.name} failed:`, err);
      console.warn(`[profile] stall evidence at ${vp.name}:\n${dumpStallEvidence()}\n${await probeStalledPage()}`);
      viewportProfiles.push({ name: vp.name, width: vp.width, height: vp.height, lcp: NaN, cls: NaN, longTaskWorstMs: NaN, domNodes: NaN, ok: false });
    }
  }
  // Restore the desktop viewport for the long-session phase.
  await page.setViewportSize({ width: 1280, height: 720 });

  // ── Phase 9: Long session (leak detection) ──
  stamp("phase 9: long session");
  // WARM EVERY ROOM ONCE BEFORE THE SNAPSHOT. Rooms mount lazily ("kept
  // alive, flipped, never unmounted" — the first open pays the mount), and
  // this phase follows phase 8's three reloads on a freshly-booted page, so
  // without the warm-up the measured "growth" IS the first mounts:
  // +3,755 nodes that are a page-revival artifact, not session retention.
  // Once warm, the loop's growth is zero on a healthy tree (measured
  // 2026-08-30: standalone probe stable at 3,960 nodes across 6 loops), so
  // the budget's number answers what its name asks — what the session
  // retains — and a real leak shows past it.
  for (const id of rooms) {
    await harness.measureRoomOpen(id);
  }
  await closeRoom();
  await page.waitForTimeout(300);
  await harness.snapshotMemory("long-session-start");
  for (let i = 0; i < 6; i++) {
    for (const id of rooms) {
      await harness.measureRoomOpen(id);
    }
    await closeRoom();
  }
  await page.waitForTimeout(500);
  await page.evaluate(() => (window as { gc?: () => void }).gc?.());
  await harness.snapshotMemory("long-session-end");

  // ── Phase 10: Finalize + build + write the report ──
  stamp("phase 10: finalize");
  await harness.finalizeNetwork();
  const ua = await page.evaluate(() => navigator.userAgent);
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  // The tree the profile measured, recorded so the regression gate can bind
  // freshness to the MEASURED SURFACE's content, not to HEAD's sha and never
  // to the clock. The profile serves the dev server, which serves the working
  // tree — so the identity is the measured surface's content hash plus HEAD's
  // sha (provenance) plus whether the tree carried uncommitted work. A commit
  // that moves HEAD without touching the surface leaves the hash put, and the
  // report stays fresh — the mirror-commit treadmill this replaces cost a
  // full regeneration per branch per round for zero measured change. All
  // three answers come from the single tree-identity owner
  // (`engine/src/shared/tree-identity.ts`): the sha from the filesystem (no
  // subprocess), the surface hash + dirty flag from the shared git reads — so
  // this consumer never parses git output itself and cannot drift from the
  // other readers of "what did the tree look like".
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const headSha = readRepositoryHeadSha(repositoryRoot);
  if (headSha === null) {
    throw new Error(
      "the repository's HEAD sha could not be read — refusing to write a profile report " +
      "with no tree identity (a sha-less report is one the regression gate cannot judge)",
    );
  }
  const measuredSurfaceHash = readMeasuredSurfaceHash(repositoryRoot);
  if (measuredSurfaceHash === null) {
    throw new Error(
      "the measured surface's content hash could not be read — refusing to write a profile report " +
      "with no surface identity (a report that cannot name the content it measured is unjudgeable)",
    );
  }
  const dirty = readWorkingTreeDirty(repositoryRoot);
  if (dirty === null) {
    throw new Error(
      "the working tree's dirtiness could not be read — refusing to write a profile report " +
      "whose dirtiness is a guess (a sha names only a clean tree)",
    );
  }
  const treeIdentity: TreeIdentity = { headSha, measuredSurfaceHash, dirty };
  const report = buildReport({
    url: BASE,
    userAgent: ua,
    viewport: vp,
    treeIdentity,
    pageLoad,
    pageLoadWarmUp: { wallClockMs: round(warmUpWallMs) },
    cdpAtLoad,
    harness,
    tabs: tabResults,
    interactions,
    interactiveElements: interactiveProfiles,
    discoveredRoutes,
    routeProfiles,
    routeIsolation,
    realData: { longChat: longChatResult, manyProjects: manyProjectsResult },
    viewports: viewportProfiles,
  });
  // Whether this profile ran inside the host's one instrument lock (taken by the
  // perf config's global setup): the regression gate judges only a held one.
  await writeReport(REPORT_PATH, report);
  await testInfo.attach("profile-page-diagnostics", { body: JSON.stringify({ pageEvidence, failedResponses, pendingApi: [...pendingApi], pendingAll: [...pendingAll] }), contentType: "application/json" });

  // ── Inline safety assertions (coarse; precise gates in the regression test) ──
  expect(report.tabs.length, "at least 4 rooms were profiled").toBeGreaterThanOrEqual(4);
  expect(Number.isFinite(report.pageLoad.lcp), "LCP was measured").toBe(true);
  expect(report.network.length, "captured API calls").toBeGreaterThan(0);
  expect(report.discoveredRoutes.length, "discovered API routes from source").toBeGreaterThan(50);
  expect(report.interactiveElements.length, "profiled interactive elements").toBeGreaterThan(0);
  expect(report.realData.longChat.ok, "complete visible long-chat phase").toBe(true);
  expect(report.realData.manyProjects.ok, "complete real project population phase").toBe(true);
});
