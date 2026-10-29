/**
 * THE RENDERED JUDGEMENT — runs the one rule table (rules.ts) against pages a
 * real browser has rendered. Two callers, one runner:
 *
 *   - the cockpit: the capture walk (scripts/capture/cockpit.ts) prepares
 *     every context with `instrumentContext`, opens every page with
 *     `openPage`, calls `judgeStates` on every view it reaches and
 *     `judgeFuture` before it leaves one; `--judge-only` is that walk without
 *     images (CI);
 *   - the site: `node scripts/rendered/judge.ts site --site <built site>
 *     --baseurl <base path>` serves a built site on loopback and judges every
 *     HTML page it holds the same way, in every render state of the site.
 *
 * Each state is judged once the page is READY (`ready`): no request in flight
 * and every frame's fonts settled, each known from its event — never a sleep,
 * and never a time limit (a page that keeps loading is waited for, and the
 * wait is logged). Then `judgeFuture` runs the page's clock forward (rules.ts
 * FUTURE_MS, in STEP_MS steps, judging after each), so a change any timer,
 * interval or animation frame makes later is judged too, in no wall time.
 *
 * Everything the page does that a later look could miss is recorded in Node
 * as it happens, from every frame (even one removed since): each canvas font,
 * each Content-Security-Policy violation, and whatever cannot be judged — a
 * worker (seen as the browser attaches it, so even one that ended at once), a
 * closed shadow root. The request rows see every request for the whole
 * session.
 *
 * It prints one finding per line and exits 1 when any rule is broken. Typed
 * refusals (`rendered_*`) for a run that cannot judge at all.
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { chromium, type Browser, type BrowserContext, type CDPSession, type Frame, type Page } from "playwright-core";

import { bootstrapProcess, isEntryPoint } from "../../engine/src/runtime/cli-debug.ts";
import { SERVED_HTML, SITE_THEME_STORAGE } from "../../shared/site-page.ts";
import { FRAMES_NOT_JUDGED, FUTURE_MS, JUDGE_LIMITS, KIT, RENDER_STATES, RENDERED_RULES, STEP_MS, type PageRule, type Recorded, type Scope, type RenderState, type RequestRule, type Surface } from "./rules.ts";

class RenderedRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/**
 * The browser a judgement drives: the one at `executable` when given (CI
 * passes the runner image's Google Chrome, probed, never downloaded), else
 * Playwright's own Chromium. Either is a real browser; the rules judge
 * computed styles, fonts and requests, not pixels.
 */
export function launchBrowser(executable: string | null, args: readonly string[] = []): Promise<Browser> {
  return chromium.launch({ headless: true, args: [...args], ...(executable === null ? { channel: "chromium" } : { executablePath: executable }) });
}

const pageRules = (surface: Surface): readonly PageRule[] => RENDERED_RULES.filter((r): r is PageRule => r.kind === "page" && r.surfaces.includes(surface));
const requestRules = (surface: Surface): readonly RequestRule[] => RENDERED_RULES.filter((r): r is RequestRule => r.kind === "request" && r.surfaces.includes(surface));

/** The binding every frame the judge instruments records through. */
const BINDING = "__renderedRecord";

/**
 * What one page recorded as it ran (rules.ts `Recorded`), each entry with
 * whether it counts (one from a frame FRAMES_NOT_JUDGED declares does not;
 * that is settled as it arrives, and a judgement waits for it).
 */
type Entry = Readonly<{ kind: string; value: string; counts: Promise<boolean> }>;
type Journal = { entries: Entry[] };
const journals = new WeakMap<Page, Journal>();
const sessions = new WeakMap<Page, CDPSession>();
/** The surface each instrumented context judges (a frame exclusion is declared per surface). */
const surfaces = new WeakMap<BrowserContext, Surface>();
/** Each instrumented context's scope: its surface and the base path its pages are served under (a row's input is built for it). */
const scopes = new WeakMap<BrowserContext, Scope>();

function record(page: Page, frame: Frame | null, kind: unknown, value: unknown): void {
  const journal = journals.get(page);
  if (journal === undefined) return; // a window the walk did not open: reported when it opens (instrumentContext)
  const known = kind === "canvas-font" || kind === "csp" || kind === "unjudgeable";
  const surface = surfaces.get(page.context());
  const counts = frame === null || surface === undefined ? Promise.resolve(true) : excluded(frame, surface).then((skip) => !skip, () => true);
  journal.entries.push({ kind: known ? kind : "unjudgeable", value: known ? String(value) : `an unknown record ${String(kind)}: ${String(value)}`, counts });
}

/** What `page` recorded that counts, as the rows read it. */
async function recordedOf(page: Page, journal: Journal, closed: readonly string[]): Promise<Recorded> {
  const counted = new Map<string, Set<string>>([["canvas-font", new Set()], ["csp", new Set()], ["unjudgeable", new Set()]]);
  for (const entry of journal.entries) if (await entry.counts) counted.get(entry.kind)?.add(entry.value);
  return {
    canvasFonts: [...counted.get("canvas-font")!],
    cspViolations: [...counted.get("csp")!],
    unjudgeable: [...counted.get("unjudgeable")!, ...closed],
  };
}

/**
 * THE ONE INSTRUMENT of a frame — every frame of every page, from its first
 * byte (an init script; self-contained, as it runs there). A canvas names its
 * family in its context's font, so the font is recorded at the context's own
 * prototype — on every assignment (whatever its spelling: ctx.font =,
 * ctx["font"] =, Object.assign, +=, another frame's setter) and on every text
 * it draws (the default font included) — never at a spelling. A shared
 * worker, which no frame or CDP attach reaches, is recorded as it is made, and
 * so is a delayed scheduler.postTask, which the page clock does not run.
 */
function instrumentFrame(binding: string): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  const call = scope[binding];
  if (typeof call !== "function") {
    scope.__renderedUninstrumented = `the ${binding} binding is missing`;
    return;
  }
  // The page's own layout shifts, summed (the layout-shift row reads them). The
  // count opens once the page is ready as it loaded (judgeStates): a shift
  // made while it loads, a web font's swap among them, lands when the host
  // lets it, so counting it judged the host, not the page (#632). The judge
  // stops counting while it changes the viewport and the media itself, and
  // counts again through the page's future (judgeFuture): a judge resizing a
  // page is not the page shifting.
  const shift = { value: 0, counting: false, set: (on: boolean): void => { void on; } };
  scope.__renderedShift = shift;
  try {
    const add = (entries: readonly PerformanceEntry[]): void => {
      // Every shift while counting: the only input a judged page receives is
      // the judge's own (forced states, done while the count is off), so the
      // browser's hadRecentInput would hide the page's next shift, not a reader's.
      for (const entry of entries as unknown as readonly { value: number }[]) {
        if (shift.counting) shift.value += entry.value;
      }
    };
    const observer = new PerformanceObserver((list) => add(list.getEntries()));
    observer.observe({ type: "layout-shift", buffered: true });
    // Entries are delivered late; before the count is switched, the ones
    // already made are taken now, so each lands on the side it happened on.
    shift.set = (on: boolean): void => {
      add(observer.takeRecords());
      shift.counting = on;
    };
  } catch { /* a frame without the Layout Instability API records no shift */ }
  const sent = new Set<string>();
  const send = (kind: string, value: string): void => {
    const key = `${kind}\n${value}`;
    if (sent.has(key)) return;
    sent.add(key);
    void (call as (k: string, v: string) => unknown)(kind, value);
  };
  for (const name of ["CanvasRenderingContext2D", "OffscreenCanvasRenderingContext2D"]) {
    const proto = (scope[name] as { prototype: Record<string, unknown> } | undefined)?.prototype;
    const descriptor = proto === undefined ? undefined : Object.getOwnPropertyDescriptor(proto, "font");
    if (proto === undefined || descriptor?.set === undefined || descriptor.get === undefined) continue;
    const { get, set } = descriptor;
    Object.defineProperty(proto, "font", {
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
      get(this: object) { return get.call(this); },
      set(this: object, value: string) { set.call(this, value); send("canvas-font", String(get.call(this))); },
    });
    for (const draw of ["fillText", "strokeText"]) {
      const original = proto[draw] as ((...args: unknown[]) => unknown) | undefined;
      if (typeof original !== "function") continue;
      proto[draw] = function (this: object, ...args: unknown[]): unknown {
        send("canvas-font", String(get.call(this)));
        return original.apply(this, args);
      };
    }
  }
  // A delayed scheduler.postTask runs on the browser's scheduler, which the page clock does not fake: refused,
  // at the prototype (however it is called), so the future the judge runs never misses it in silence.
  const scheduler = (scope.Scheduler as { prototype: Record<string, unknown> } | undefined)?.prototype;
  const postTask = scheduler?.postTask as ((this: object, callback: unknown, options?: { delay?: number }) => unknown) | undefined;
  if (scheduler !== undefined && typeof postTask === "function") {
    scheduler.postTask = function (this: object, callback: unknown, options?: { delay?: number }): unknown {
      const delay = Number(options?.delay ?? 0);
      if (delay > 0) send("unjudgeable", `a scheduler.postTask with a ${String(delay)} ms delay: the page's clock does not run it forward`);
      return postTask.call(this, callback, options);
    };
  }
  // A worklet (paint, audio) runs its module where no frame instrument reaches: refused as it is added.
  const worklet = (scope.Worklet as { prototype: Record<string, unknown> } | undefined)?.prototype;
  const addModule = worklet?.addModule as ((this: object, ...args: unknown[]) => unknown) | undefined;
  if (worklet !== undefined && typeof addModule === "function") {
    worklet.addModule = function (this: object, ...args: unknown[]): unknown {
      send("unjudgeable", `a worklet module (${String(args[0])}): what it paints or plays is out of the judgement's reach`);
      return addModule.apply(this, args);
    };
  }
  const Shared = scope.SharedWorker as (new (...args: unknown[]) => object) | undefined;
  if (typeof Shared === "function") {
    scope.SharedWorker = function (...args: unknown[]): object {
      send("unjudgeable", `a shared worker (${String(args[0])}): the judgement does not reach inside a worker`);
      return new Shared(...args);
    };
  }
  document.addEventListener("securitypolicyviolation", (event) => { send("csp", `${event.violatedDirective} blocked ${event.blockedURI || "an inline resource"}`); });
  scope.__renderedInstrumented = true;
}

/** Requests in flight per page (the network half of "ready"), their URLs (to say what a page waits on), and who waits. */
const inFlight = new WeakMap<Page, number>();
const openUrls = new WeakMap<Page, Set<string>>();
const waiters = new WeakMap<Page, (() => void)[]>();
/** Pages openPage is opening in a context (any other page there is a window the page opened). */
const opening = new WeakMap<BrowserContext, number>();

/**
 * Instruments `context` for the table, once, before any page opens, for the
 * whole session: the page clock is installed (judgeFuture runs it forward),
 * every frame is instrumented from its first byte (`instrumentFrame`), and
 * every request rule of `surface` sees every request. A window the page opens
 * itself is reported: only pages opened by `openPage` are judged.
 */
export async function instrumentContext(context: BrowserContext, surface: Surface, origin: string, report: (finding: string) => void, base = ""): Promise<void> {
  scopes.set(context, Object.freeze({ surface, base }));
  // NO WALL-CLOCK LIMIT on anything a judgement waits for — a navigation, an action, a wait — set here, once, for
  // every judged context: under host load a slow page is still a page, and Playwright's 30 s defaults would fail
  // it. A long wait logs its progress (`navigate`, `ready`); a true hang is bounded by the run's own backstop
  // (the instrument lock's supervisor, the CI job's timeout), never by a guess at how long a page may take.
  context.setDefaultTimeout(0);
  context.setDefaultNavigationTimeout(0);
  surfaces.set(context, surface);
  await context.clock.install();
  await context.exposeBinding(BINDING, ({ page, frame }: { page: Page; frame: Frame }, kind: unknown, value: unknown) => record(page, frame, kind, value));
  await context.addInitScript({ content: `(${instrumentFrame.toString()})(${JSON.stringify(BINDING)});` });
  context.on("page", (page) => {
    const expected = opening.get(context) ?? 0;
    if (expected > 0) opening.set(context, expected - 1);
    else report(`[judgeable] the page opened a window the judgement does not judge: ${page.url()}`);
  });
  const rules = requestRules(surface);
  const page = (request: { frame(): { page(): Page } }): Page | null => { try { return request.frame().page(); } catch { return null; } };
  // A request to the network is loading until it ends — or, for a stream (server-sent events, a WebSocket),
  // until it opens: a stream is a channel the page keeps, not part of loading. A blob: or data: URL is the
  // page's own bytes, not a load (and a worker's never reports its end).
  const open = new WeakSet<object>();
  const loads = (request: { resourceType(): string; headers(): Record<string, string>; url(): string }): boolean =>
    /^https?:/u.test(request.url()) && !["eventsource", "websocket"].includes(request.resourceType()) && !/text\/event-stream/iu.test(request.headers()["accept"] ?? "");
  const begin = (request: { frame(): { page(): Page }; resourceType(): string; headers(): Record<string, string>; url(): string }): void => {
    const p = page(request);
    if (p === null || !loads(request)) return;
    open.add(request);
    inFlight.set(p, (inFlight.get(p) ?? 0) + 1);
    openUrls.set(p, (openUrls.get(p) ?? new Set<string>()).add(request.url()));
  };
  const end = (request: { frame(): { page(): Page }; url(): string }): void => {
    if (!open.has(request)) return;
    open.delete(request);
    const p = page(request);
    if (p === null) return;
    const left = Math.max(0, (inFlight.get(p) ?? 0) - 1);
    inFlight.set(p, left);
    openUrls.get(p)?.delete(request.url());
    if (left === 0) for (const done of waiters.get(p)?.splice(0) ?? []) done();
  };
  context.on("response", (response) => {
    const type = response.headers()["content-type"] ?? "";
    if (/text\/event-stream/iu.test(type)) end(response.request());
  });
  context.on("request", (request) => {
    begin(request);
    for (const rule of rules) {
      const finding = rule.judge(request.url(), request.resourceType(), origin, base);
      if (finding !== null) report(`[${rule.id}] ${finding}`);
    }
  });
  context.on("requestfinished", (request) => end(request));
  context.on("requestfailed", (request) => end(request));
}

/**
 * Opens a page in an instrumented context, with its journal, and watches the
 * workers it starts: the browser attaches each dedicated worker to the page's
 * CDP session as it is made, and each is recorded as out of the judgement's
 * reach — whatever it draws happens where no frame instrument runs, and it
 * cannot be held for one before it runs (Playwright's own session resumes
 * it). The only way a judged page is opened.
 */
export async function openPage(context: BrowserContext): Promise<Page> {
  const journal: Journal = { entries: [] };
  opening.set(context, (opening.get(context) ?? 0) + 1);
  const page = await context.newPage();
  journals.set(page, journal);
  const cdp = await context.newCDPSession(page);
  sessions.set(page, cdp);
  cdp.on("Target.attachedToTarget", (event: { targetInfo: { type: string; url: string } }) => {
    if (event.targetInfo.type === "worker") record(page, null, "unjudgeable", `a worker (${event.targetInfo.url}): the judgement does not reach inside a worker`);
  });
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
  // A new document starts a new record (what the last one recorded was judged before it was left).
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) journal.entries = [];
  });
  return page;
}

/** Opens `url` in `page` and waits for its load event, with no time limit; a long load logs what it is waiting on. */
export async function navigate(page: Page, url: string): Promise<void> {
  const started = Date.now();
  const liveness = setInterval(() => {
    process.stderr.write(`[rendered] loading ${url} for ${String(Math.round((Date.now() - started) / 1000))} s: ${String(inFlight.get(page) ?? 0)} requests in flight (${[...(openUrls.get(page) ?? [])].slice(-3).join(", ")})\n`);
  }, 10_000);
  try {
    // The page's clock holds from before it loads: its timers and frames run
    // only when the judge runs them (judgeStates' first step, inside the shift
    // count), never during the wait for the page to be ready, however long the
    // host makes that wait (#632). Its time is the context's clock's, read from
    // the page, which may already be ahead of the host's.
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + STEP_MS);
    await page.goto(url, { waitUntil: "load" });
  } finally {
    clearInterval(liveness);
  }
}

/** Waits, by events, until `page` has no request in flight; a long wait is logged (never judged by its length). */
function idle(page: Page): Promise<void> {
  if ((inFlight.get(page) ?? 0) === 0) return Promise.resolve();
  return new Promise((done) => {
    const started = Date.now();
    const liveness = setInterval(() => {
      process.stderr.write(`[rendered] waiting ${String(Math.round((Date.now() - started) / 1000))} s on ${String(inFlight.get(page) ?? 0)} requests (${[...(openUrls.get(page) ?? [])].slice(-3).join(", ")})\n`);
    }, 10_000);
    waiters.set(page, [...(waiters.get(page) ?? []), () => { clearInterval(liveness); done(); }]);
  });
}

/**
 * Waits until `page` is READY to be judged: no request in flight and every
 * judged frame's fonts settled (document.fonts.ready), then no request again
 * (a font is a request). Events only: no sleep, no limit.
 */
export async function ready(page: Page): Promise<void> {
  if (!journals.has(page)) throw new RenderedRefusal("rendered_not_instrumented", "the page was not opened by openPage in a context instrumentContext prepared");
  await idle(page);
  for (const frame of page.frames()) if (!frame.isDetached()) await frame.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => undefined);
  await idle(page);
}

/**
 * Whether `frame`, or a frame it sits in, is one rules.ts declares not judged
 * on `surface`: its element carries the declared attribute AND the browser
 * gave the frame an opaque origin (a sandbox without allow-same-origin).
 */
async function excluded(frame: Frame, surface: Surface): Promise<boolean> {
  const declared = FRAMES_NOT_JUDGED.filter((d) => d.surfaces.includes(surface));
  if (declared.length === 0) return false;
  for (let at: Frame | null = frame; at?.parentFrame() != null; at = at.parentFrame()) {
    const element = await at.frameElement();
    const named = await element.evaluate((el, rows) => rows.some((d) => (el as Element).getAttribute(d.attribute) === d.value), declared);
    await element.dispose();
    if (named && (await at.evaluate(() => self.origin)) === "null") return true;
  }
  return false;
}

/** Every frame of `page` the rows run in on `surface`: all of them, but a detached one and those FRAMES_NOT_JUDGED declares. */
async function judgedFrames(page: Page, surface: Surface): Promise<readonly Frame[]> {
  const frames: Frame[] = [];
  for (const frame of page.frames()) {
    if (frame.isDetached()) continue;
    try {
      if (await excluded(frame, surface)) continue;
    } catch (error) {
      if (frame.isDetached()) continue;
      throw error;
    }
    frames.push(frame);
  }
  return frames;
}

export type DomNode = { nodeId: number; backendNodeId: number; nodeType: number; nodeName: string; localName?: string; attributes?: string[]; children?: DomNode[]; shadowRoots?: (DomNode & { shadowRootType?: string })[]; contentDocument?: DomNode };

/** The browser's own tree of `page`, piercing every shadow root and frame (CDP). */
async function domTree(page: Page): Promise<DomNode> {
  return ((await sessions.get(page)!.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode }).root;
}

/** Whether a node of the tree is a frame FRAMES_NOT_JUDGED declares on `surface`: the attribute, and a sandbox without allow-same-origin. */
function declaredFrame(node: DomNode, surface: Surface): boolean {
  if (node.contentDocument === undefined) return false;
  const attributes = new Map<string, string>();
  for (let i = 0; i + 1 < (node.attributes ?? []).length; i += 2) attributes.set(node.attributes![i]!, node.attributes![i + 1]!);
  const sandbox = attributes.get("sandbox");
  return sandbox !== undefined && !sandbox.split(/\s+/u).includes("allow-same-origin") &&
    FRAMES_NOT_JUDGED.some((d) => d.surfaces.includes(surface) && attributes.get(d.attribute) === d.value);
}

/** What `page` holds out of the rows' reach, read from the browser's own tree: each closed shadow root. */
async function unreachable(page: Page, surface: Surface): Promise<readonly string[]> {
  const root = await domTree(page);
  await sessions.get(page)!.send("DOM.disable");
  return closedRootsIn(root, surface);
}

function closedRootsIn(root: DomNode, surface: Surface): readonly string[] {
  const found: string[] = [];
  const walk = (node: DomNode): void => {
    if (declaredFrame(node, surface)) return;
    for (const shadow of node.shadowRoots ?? []) {
      if (shadow.shadowRootType === "closed") found.push(`a closed shadow root on <${node.localName ?? node.nodeName.toLowerCase()}>: what it renders cannot be judged`);
      else if (shadow.shadowRootType === "open") walk(shadow);
    }
    for (const child of node.children ?? []) walk(child);
    if (node.contentDocument !== undefined) walk(node.contentDocument);
  };
  walk(root);
  return found;
}

/** Each page row as a function that runs in a frame, with the kit beside it (built once). */
const runners = new Map<PageRule, (args: unknown) => string[]>();
const kitSource = `{ ${Object.entries(KIT).map(([name, helper]) => `${name}: ${helper.toString()}`).join(", ")} }`;
function runnerOf(rule: PageRule): (args: unknown) => string[] {
  let runner = runners.get(rule);
  if (runner === undefined) {
    // The row's own source, sent to the browser: it runs there, never here.
    runner = new Function("args", `return (${rule.judge.toString()})(args, ${kitSource});`) as (args: unknown) => string[];
    runners.set(rule, runner);
  }
  return runner;
}

/**
 * Every page row of `surface` (or exactly `rules`, for the proof), judged on
 * the view `page` shows now, in every judged frame; each finding names its
 * rule (and its frame, when it is not the page's own).
 */
export async function judgePage(page: Page, surface: Surface, rules: readonly PageRule[] = pageRules(surface), closed?: readonly string[]): Promise<readonly string[]> {
  const journal = journals.get(page);
  if (journal === undefined) throw new RenderedRefusal("rendered_not_instrumented", "the page was not opened by openPage in a context instrumentContext prepared");
  const recorded = await recordedOf(page, journal, closed ?? (await unreachable(page, surface)));
  const findings: string[] = [];
  for (const frame of await judgedFrames(page, surface)) {
    const top = frame === page.mainFrame();
    const missing = await frame.evaluate(() => {
      const scope = globalThis as unknown as { __renderedInstrumented?: boolean; __renderedUninstrumented?: string };
      return scope.__renderedInstrumented === true ? null : (scope.__renderedUninstrumented ?? "its instrument never ran");
    });
    if (missing !== null) throw new RenderedRefusal("rendered_not_instrumented", `the frame ${frame.url()} was not instrumented: ${missing}`);
    const where = top ? "" : `in the frame ${frame.url().slice(0, 80)}: `;
    for (const rule of rules) {
      const args = { input: rule.input(scopes.get(page.context()) ?? { surface, base: "" }), surface, top, record: top ? recorded : null };
      for (const finding of await frame.evaluate(runnerOf(rule), args)) findings.push(`[${rule.id}] ${where}${finding}`);
    }
  }
  return findings;
}

/** How a judgement leaves the page: the media, motion, viewport and scheme to put back (the capture's own). */
export type RenderRestore = Readonly<{ media: "screen" | "print"; reducedMotion: "reduce" | "no-preference"; colorScheme: "light" | "dark"; viewport: Readonly<{ width: number; height: number }> | null }>;

/**
 * Every page row of `surface`, in every render state of `surface`, each once
 * the page is ready; then the page is put back as `restore` says. Returns the
 * findings, each naming its state and rule.
 */
/** Starts or stops counting the page's layout shifts, in every frame (see instrumentFrame). */
async function countShifts(page: Page, counting: boolean): Promise<void> {
  for (const frame of page.frames()) {
    if (frame.isDetached()) continue;
    await frame.evaluate((on) => {
      (globalThis as unknown as { __renderedShift?: { set: (on: boolean) => void } }).__renderedShift?.set(on);
    }, counting).catch(() => undefined);
  }
}

export async function judgeStates(page: Page, surface: Surface, restore: RenderRestore | null, rules?: readonly PageRule[], states: readonly RenderState[] = statesOf(surface)): Promise<readonly string[]> {
  const findings: string[] = [];
  // The load is over once the page is ready as it loaded (its requests done,
  // its fonts settled) and a frame is drawn: the count opens there, and what
  // the load moved before it, a late web font's swap among them, is not
  // counted (#632). The judge's own viewport and media changes that follow
  // are not the page shifting either. The page's clock holds still while the
  // judge changes it, so what the page does next (a timer, a frame) happens
  // after, where its shifts count again. The page's clock, held since before
  // it loaded (navigate), runs one step on (its load's own timers and frames
  // fire and count) and then holds; a frame is drawn so those shifts are made
  // before the count is switched off.
  await ready(page);
  await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
  await countShifts(page, true);
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + STEP_MS);
  await ready(page);
  await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
  await countShifts(page, false);
  for (const state of states) {
    await enter(page, state);
    await ready(page);
    for (const finding of await judgePage(page, surface, rules)) findings.push(`(${state.id}) ${finding}`);
  }
  if (restore !== null) {
    if (restore.viewport !== null) await page.setViewportSize({ ...restore.viewport });
    await page.emulateMedia({ media: restore.media, reducedMotion: restore.reducedMotion, colorScheme: restore.colorScheme });
    await ready(page);
  }
  for (const finding of await judgeForcedStates(page, surface, rules)) findings.push(`(hover, active and focus forced) ${finding}`);
  // A frame is drawn (a screenshot of one pixel), so every shift the judge's
  // own changes caused is made and taken before the count runs again; then
  // the page's clock runs on, and what the page does next is its own shift.
  await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
  await countShifts(page, true);
  await page.clock.resume();
  return findings;
}

/** The elements that can take focus (the others are forced into hover, active and focus-within only). */
const FOCUSABLE = new Set(["a", "area", "button", "details", "iframe", "input", "select", "summary", "textarea"]);

/**
 * The rows once more with the states a pointer and a keyboard put elements
 * in — :hover, :active and :focus-within on every element, :focus and
 * :focus-visible on every one that can take focus — forced by the browser
 * itself (CDP CSS.forcePseudoState), all at once, then released.
 */
async function judgeForcedStates(page: Page, surface: Surface, rules?: readonly PageRule[]): Promise<readonly string[]> {
  const cdp = sessions.get(page)!;
  const send: CdpSend = (method, params) => cdp.send(method as never, params as never);
  await send("DOM.enable");
  await send("CSS.enable");
  try {
    const forced = await forceEveryElement(send, surface);
    await ready(page);
    const findings = await judgePage(page, surface, rules, closedRootsIn(forced.root, surface));
    await releaseForcedStates(send, forced);
    return findings;
  } finally {
    await send("CSS.disable");
    await send("DOM.disable");
  }
}

/** One CDP call on a page's session (the forcing below takes it as a port, so it is driven without a browser too). */
export type CdpSend = (method: string, params?: object) => Promise<unknown>;

/**
 * What a forcing pass forced: the tree it read, and each element it forced
 * by node id. The ids hold for the whole pass because the tree is read ONCE:
 * reading it again (DOM.getDocument) discards the session's node bindings,
 * and the states forced through them with it.
 */
export type ForcedStates = Readonly<{ root: DomNode; forced: ReadonlySet<number> }>;

/**
 * How many times a forcing pass looks for elements the page added since it
 * read the tree (DOM.querySelectorAll in each document and open shadow root
 * it read, which keeps the bindings): an element added after the last look is
 * judged unforced (rules.ts JUDGE_LIMITS, forced-states-churn).
 */
const FORCING_LOOKS = 2;

/** The CDP answer for a node id whose node is no longer in the page. */
const NODE_GONE = /Could not find node with given id/u;

/** The elements that can take focus, as a selector (FOCUSABLE's tags, and any element with a tab index or that is editable). */
const FOCUSABLE_SELECTOR = [...FOCUSABLE, "[tabindex]", "[contenteditable]"].join(", ");
const ALL_STATES = ["hover", "active", "focus", "focus-visible", "focus-within"];
const POINTER_STATES = ["hover", "active", "focus-within"];

/** Every element of a snapshot `root` the forcing reaches (not inside a declared frame), with its classes, and the scopes it was found in. */
function forcingTargets(root: DomNode, surface: Surface): { targets: { nodeId: number; classes: string[] }[]; scopes: number[] } {
  const targets: { nodeId: number; classes: string[] }[] = [];
  const scopes: number[] = [];
  const walk = (node: DomNode): void => {
    if (declaredFrame(node, surface)) return;
    if (node.nodeType === 9 || node.nodeType === 11) scopes.push(node.nodeId);
    if (node.nodeType === 1) {
      const attributes = node.attributes ?? [];
      const focusable = FOCUSABLE.has(node.localName ?? "") || attributes.some((name, i) => i % 2 === 0 && (name === "tabindex" || name === "contenteditable"));
      targets.push({ nodeId: node.nodeId, classes: focusable ? ALL_STATES : POINTER_STATES });
    }
    for (const shadow of node.shadowRoots ?? []) if (shadow.shadowRootType === "open") walk(shadow);
    for (const child of node.children ?? []) walk(child);
    if (node.contentDocument !== undefined) walk(node.contentDocument);
  };
  walk(root);
  return { targets, scopes };
}

/**
 * Forces every element of the page's tree into its states. The page is live:
 * a node it removes between the read and the call is GONE (CDP answers that
 * the node id is unknown) and is skipped; an element it adds meanwhile is
 * found by looking again in every scope the read reached, under the same
 * bindings, and forced too. Any other CDP answer is refused.
 */
export async function forceEveryElement(send: CdpSend, surface: Surface): Promise<ForcedStates> {
  const { root } = (await send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode };
  const { targets, scopes } = forcingTargets(root, surface);
  const forced = new Set<number>();
  const seen = new Set<number>();
  const force = (batch: readonly { nodeId: number; classes: readonly string[] }[]): Promise<unknown> => Promise.all(batch.map(async ({ nodeId, classes }) => {
    seen.add(nodeId);
    if (await forceOne(send, nodeId, classes)) forced.add(nodeId);
  }));
  await force(targets);
  for (let look = 0; look < FORCING_LOOKS; look += 1) {
    const fresh: { nodeId: number; classes: readonly string[] }[] = [];
    for (const scope of scopes) {
      const all = await queryIn(send, scope, "*");
      if (all === null) continue;
      const focusable = new Set((await queryIn(send, scope, FOCUSABLE_SELECTOR)) ?? []);
      for (const nodeId of all) if (!seen.has(nodeId)) fresh.push({ nodeId, classes: focusable.has(nodeId) ? ALL_STATES : POINTER_STATES });
    }
    if (fresh.length === 0) break;
    await force(fresh);
  }
  return { root, forced };
}

/** The elements matching `selector` in the scope `nodeId` (a document or a shadow root), or null when the scope is gone. */
async function queryIn(send: CdpSend, nodeId: number, selector: string): Promise<readonly number[] | null> {
  try {
    return ((await send("DOM.querySelectorAll", { nodeId, selector })) as { nodeIds: number[] }).nodeIds;
  } catch (error) {
    if (NODE_GONE.test(error instanceof Error ? error.message : String(error))) return null;
    throw error;
  }
}

/** Releases every element `forced` forced that is still in the page (one the page removed took its state with it). */
export async function releaseForcedStates(send: CdpSend, forced: ForcedStates): Promise<void> {
  await Promise.all([...forced.forced].map((nodeId) => forceOne(send, nodeId, [])));
}

/** Forces one node's states; false when the node is gone, and any other CDP answer is refused. */
async function forceOne(send: CdpSend, nodeId: number, classes: readonly string[]): Promise<boolean> {
  try {
    await send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: classes });
    return true;
  } catch (error) {
    if (NODE_GONE.test(error instanceof Error ? error.message : String(error))) return false;
    throw error;
  }
}

/**
 * Before a page is left: its FUTURE (rules.ts FUTURE_MS of page time, on the
 * page's clock, in every frame) runs in STEP_MS steps, and the rows are judged
 * after each step, as the page then stands; then every finite CSS animation
 * and transition (they run on the document timeline, not the clock) is
 * finished and the rows are judged once more. Each finding is reported once,
 * at the first moment it was seen.
 */
export async function judgeFuture(page: Page, surface: Surface, rules?: readonly PageRule[]): Promise<readonly string[]> {
  const first = new Map<string, string>();
  const note = (moment: string, findings: readonly string[]): void => { for (const finding of findings) if (!first.has(finding)) first.set(finding, moment); };
  for (let at = STEP_MS; at <= FUTURE_MS; at += STEP_MS) {
    await page.clock.runFor(STEP_MS);
    await ready(page);
    note(`at +${String(at / 1000)} s`, await judgePage(page, surface, rules));
  }
  for (const frame of await judgedFrames(page, surface)) {
    await frame.evaluate(() => {
      // The document's animations and each open shadow root's (document.getAnimations() does not reach into one).
      const scopes: (Document | ShadowRoot)[] = [document];
      for (let i = 0; i < scopes.length; i += 1) for (const el of scopes[i]!.querySelectorAll("*")) if (el.shadowRoot !== null) scopes.push(el.shadowRoot);
      for (const scope of scopes) {
        for (const animation of scope.getAnimations()) {
          if (Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))) animation.finish();
        }
      }
    });
  }
  await ready(page);
  note("with its animations finished", await judgePage(page, surface, rules));
  return [...first].map(([finding, moment]) => `(${moment}) ${finding}`);
}

const statesOf = (surface: Surface): readonly RenderState[] => RENDER_STATES.filter((s) => s.surfaces.includes(surface));

async function enter(page: Page, state: RenderState): Promise<void> {
  if (state.viewport !== undefined) await page.setViewportSize({ ...state.viewport });
  await page.emulateMedia({ media: state.media, reducedMotion: state.reducedMotion, ...(state.colorScheme === undefined ? {} : { colorScheme: state.colorScheme }) });
}

/** The site's own state (its first), which a judged site page is put back to before its future runs. */
export function siteRestore(): RenderRestore {
  const [first] = statesOf("site");
  if (first?.viewport === undefined || first.colorScheme === undefined) throw new RenderedRefusal("rendered_states", "the site's first render state names no viewport and scheme");
  return { media: first.media, reducedMotion: first.reducedMotion, colorScheme: first.colorScheme, viewport: first.viewport };
}

const TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".xhtml": "application/xhtml+xml",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
});

/**
 * A static server for a built site under its base path, on a free loopback
 * port. `served` answers chosen paths itself (the proof's slow but steady
 * resource); every other path is a file of the site.
 */
export async function serveSite(siteRoot: string, baseurl: string, served: Readonly<Record<string, (response: ServerResponse) => void>> = {}): Promise<{ server: Server; origin: string }> {
  const root = resolve(siteRoot);
  const base = baseurl.replace(/\/+$/u, "");
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://site").pathname);
    const own = served[path];
    if (own !== undefined) { own(response); return; }
    if (!path.startsWith(`${base}/`) && path !== base) { response.writeHead(404).end(); return; }
    let file = resolve(join(root, path.slice(base.length)));
    if (file !== root && !file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new RenderedRefusal("rendered_server_failed", "the site server has no loopback port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

/** Every HTML page a built site holds, as URL paths under `baseurl`. */
function sitePages(siteRoot: string, baseurl: string): readonly string[] {
  const base = baseurl.replace(/\/+$/u, "");
  const pages: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      // Every file Pages serves as HTML, in any case of its extension.
      else if (SERVED_HTML.test(name)) pages.push(`${base}/${relative(siteRoot, path).split(sep).join("/")}`.replace(/(?:^|\/)index\.html$/u, "/"));
    }
  };
  walk(siteRoot);
  return pages;
}

/** Judges every page of a built site in both of its themes and every site render state; returns the findings, each with its page. */
async function judgeSite(siteRoot: string, baseurl: string, executable: string | null): Promise<readonly string[]> {
  if (!existsSync(siteRoot)) throw new RenderedRefusal("rendered_site_missing", `${siteRoot} is not a built site`);
  const pages = sitePages(siteRoot, baseurl);
  if (pages.length === 0) throw new RenderedRefusal("rendered_site_empty", `${siteRoot} holds no HTML page`);
  const { server, origin } = await serveSite(siteRoot, baseurl);
  const browser = await launchBrowser(executable);
  const findings = new Set<string>();
  try {
    // The site's two themes, each through every site render state: Logbook
    // leads (nothing stored), Carbon is the reader's stored choice
    // (shared/site-page.ts SITE_THEME_STORAGE). The site does not follow the
    // system scheme, so the theme is set the way a reader sets it.
    for (const theme of ["logbook", "carbon"] as const) {
      const context = await browser.newContext({ serviceWorkers: "block" });
      await context.addInitScript(({ key, value, stored }) => {
        try {
          if (stored) localStorage.setItem(key, value);
          else localStorage.removeItem(key);
        } catch { /* a page without storage shows the lead theme */ }
      }, { key: SITE_THEME_STORAGE.key, value: SITE_THEME_STORAGE.carbon, stored: theme === "carbon" });
      let current = "";
      await instrumentContext(context, "site", origin, (finding) => findings.add(`${current} [${theme}]: ${finding}`), baseurl);
      const page = await openPage(context);
      for (const path of pages) {
        current = path;
        await navigate(page, `${origin}${path}`);
        for (const finding of await judgeStates(page, "site", siteRestore())) findings.add(`${path} [${theme}] ${finding}`);
        for (const finding of await judgeFuture(page, "site")) findings.add(`${path} [${theme}] ${finding}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
  return [...findings];
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "site") throw new RenderedRefusal("rendered_usage", "usage: judge.ts site --site <built site> --baseurl <base path> [--browser <executable>]");
  const { values } = parseArgs({ args: rest, options: { site: { type: "string" }, baseurl: { type: "string" }, browser: { type: "string" } } });
  if (values.site === undefined || values.baseurl === undefined) throw new RenderedRefusal("rendered_usage", "site needs --site and --baseurl");
  const findings = await judgeSite(resolve(values.site), values.baseurl, values.browser ?? null);
  const pages = sitePages(resolve(values.site), values.baseurl).length;
  for (const finding of findings) process.stdout.write(`${finding}\n`);
  const pending = RENDERED_RULES.flatMap((r) => (r.pending?.site === undefined ? [] : [{ id: r.id, why: r.pending.site }]));
  process.stdout.write(`${JSON.stringify({ surface: "site", pages, rules: RENDERED_RULES.filter((r) => r.surfaces.includes("site")).map((r) => r.id), pending, limits: JUDGE_LIMITS, findings: findings.length })}\n`);
  return findings.length === 0 ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`[rendered] REFUSED ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
