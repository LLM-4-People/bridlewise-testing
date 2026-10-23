/**
 * THE RENDERED JUDGEMENT — runs the one rule table (rules.ts) against pages a
 * real browser has rendered. Two callers, one runner:
 *
 *   - the cockpit: the capture walk (scripts/capture/cockpit.ts) calls
 *     `judgeStates` on every view it reaches and `instrumentContext` on every
 *     browser context; `--judge-only` is that walk without images (CI);
 *   - the site: `node scripts/rendered/judge.ts site --site <built site>
 *     --baseurl <base path>` serves a built site on loopback and judges every
 *     HTML page it holds, in every render state of the site (rules.ts).
 *
 * Each state is judged once the page is quiet (`settle`): no request in
 * flight, no short timer pending, no DOM mutation for the quiet window. The
 * request rows and the CSP listener stay on for the whole session, and a page
 * that changed after its judgement is judged again before it is left.
 *
 * It prints one finding per line and exits 1 when any rule is broken. Typed
 * refusals (`rendered_*`) for a run that cannot judge at all.
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import { bootstrapProcess, isEntryPoint } from "../../engine/src/runtime/cli-debug.ts";
import { QUIET_WINDOW_MS, RENDER_STATES, RENDERED_RULES, SETTLE_LIMIT_MS, TIMER_HORIZON_MS, type PageRule, type RenderState, type RequestRule, type Surface } from "./rules.ts";

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

/** Every page rule of `surface` (or exactly `rules`, for the proof), judged on the view `page` shows now; each finding names its rule. */
export async function judgePage(page: Page, surface: Surface, rules: readonly PageRule[] = pageRules(surface)): Promise<readonly string[]> {
  const findings: string[] = [];
  for (const rule of rules) {
    for (const finding of await page.evaluate(rule.judge, { input: rule.input() as never, surface })) findings.push(`[${rule.id}] ${finding}`);
  }
  return findings;
}

/** Requests in flight per page (the network half of "quiet"), and their URLs (to say what kept a page busy). */
const inFlight = new WeakMap<Page, number>();
const openUrls = new WeakMap<Page, Set<string>>();

/**
 * Instruments `context` for the table, once, before any page opens, for the
 * whole session: every request rule of `surface` sees every request; every
 * page records its Content-Security-Policy violations from the first byte
 * (the csp-violations row reads them) and the events that say whether it is
 * quiet (DOM mutations and short timers; requests are counted here).
 */
export async function instrumentContext(context: BrowserContext, surface: Surface, origin: string, report: (finding: string) => void): Promise<void> {
  await context.addInitScript((horizon: number) => {
    const seen: { directive: string; blocked: string }[] = [];
    const quiet = { mutations: 0, last: performance.now(), timers: 0 };
    const canvasFonts: string[] = [];
    const w = window as unknown as { __renderedCspViolations: typeof seen; __renderedQuiet: typeof quiet; __renderedCanvasFonts: string[] };
    w.__renderedCspViolations = seen;
    w.__renderedQuiet = quiet;
    w.__renderedCanvasFonts = canvasFonts;
    // A canvas names its family in its context's font: every value assigned is recorded at the setter,
    // however the assignment was spelled (ctx.font =, ctx["font"] =, Object.assign, +=), on 2D and offscreen contexts.
    for (const name of ["CanvasRenderingContext2D", "OffscreenCanvasRenderingContext2D"]) {
      const proto = (window as unknown as Record<string, { prototype: object } | undefined>)[name]?.prototype;
      const descriptor = proto === undefined ? undefined : Object.getOwnPropertyDescriptor(proto, "font");
      if (proto === undefined || descriptor?.set === undefined || descriptor.get === undefined) continue;
      const { get, set } = descriptor;
      Object.defineProperty(proto, "font", {
        configurable: true,
        enumerable: descriptor.enumerable ?? false,
        get(this: object) { return get.call(this); },
        set(this: object, value: string) { canvasFonts.push(String(value)); set.call(this, value); },
      });
    }
    document.addEventListener("securitypolicyviolation", (event) => { seen.push({ directive: event.violatedDirective, blocked: event.blockedURI }); });
    new MutationObserver(() => { quiet.mutations += 1; quiet.last = performance.now(); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    // Short timers are part of loading: a stylesheet or a family a script adds 2 s in must be waited for.
    const pending = new Set<number>();
    const setTimer = window.setTimeout.bind(window);
    const clearTimer = window.clearTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
      if ((delay ?? 0) > horizon || typeof handler !== "function") return setTimer(handler, delay, ...rest);
      const id: number = setTimer((...args: unknown[]) => {
        pending.delete(id);
        quiet.timers = pending.size;
        quiet.last = performance.now();
        (handler as (...a: unknown[]) => void)(...args);
      }, delay, ...rest);
      pending.add(id);
      quiet.timers = pending.size;
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => {
      if (id !== undefined) pending.delete(id);
      quiet.timers = pending.size;
      clearTimer(id);
    }) as typeof window.clearTimeout;
  }, TIMER_HORIZON_MS);
  const rules = requestRules(surface);
  const page = (request: { frame(): { page(): Page } }): Page | null => { try { return request.frame().page(); } catch { return null; } };
  // A request is loading until it ends — or, for a stream (server-sent events, a WebSocket), until it opens:
  // a stream is a channel the page keeps, not part of loading.
  const open = new WeakSet<object>();
  const isStream = (request: { resourceType(): string; headers(): Record<string, string> }): boolean =>
    ["eventsource", "websocket"].includes(request.resourceType()) || /text\/event-stream/iu.test(request.headers()["accept"] ?? "");
  const begin = (request: { frame(): { page(): Page }; resourceType(): string; headers(): Record<string, string> }): void => {
    const p = page(request);
    if (p === null || isStream(request)) return;
    open.add(request);
    inFlight.set(p, (inFlight.get(p) ?? 0) + 1);
    openUrls.set(p, (openUrls.get(p) ?? new Set<string>()).add((request as unknown as { url(): string }).url()));
  };
  const end = (request: { frame(): { page(): Page } }): void => {
    if (!open.has(request)) return;
    open.delete(request);
    const p = page(request);
    if (p !== null) {
      inFlight.set(p, Math.max(0, (inFlight.get(p) ?? 0) - 1));
      openUrls.get(p)?.delete((request as unknown as { url(): string }).url());
    }
  };
  context.on("response", (response) => {
    const type = response.headers()["content-type"] ?? "";
    if (/text\/event-stream/iu.test(type)) end(response.request());
  });
  context.on("request", (request) => {
    begin(request);
    for (const rule of rules) {
      const finding = rule.judge(request.url(), request.resourceType(), origin);
      if (finding !== null) report(`[${rule.id}] ${finding}`);
    }
  });
  context.on("requestfinished", (request) => end(request));
  context.on("requestfailed", (request) => end(request));
}

/**
 * Waits until `page` is QUIET: no request in flight, no short timer pending,
 * and no DOM mutation for QUIET_WINDOW_MS — each measured from its events. A
 * page still busy at SETTLE_LIMIT_MS is judged as it stands; the answer says
 * so, and the caller reports it.
 */
export async function settle(page: Page): Promise<"quiet" | "busy"> {
  const started = Date.now();
  let last = "";
  for (;;) {
    const state = await page.evaluate(() => {
      const q = (window as unknown as { __renderedQuiet?: { last: number; timers: number } }).__renderedQuiet;
      return q === undefined ? null : { idle: performance.now() - q.last, timers: q.timers };
    });
    if (state === null) throw new RenderedRefusal("rendered_not_instrumented", "the page was opened in a context instrumentContext did not prepare");
    if ((inFlight.get(page) ?? 0) === 0 && state.timers === 0 && state.idle >= QUIET_WINDOW_MS) return "quiet";
    last = `requests in flight ${String(inFlight.get(page) ?? 0)} (${[...(openUrls.get(page) ?? [])].slice(-3).join(", ")}), short timers ${String(state.timers)}, idle ${String(Math.round(state.idle))} ms`;
    if (Date.now() - started > SETTLE_LIMIT_MS) {
      process.stderr.write(`[rendered] still busy: ${last}\n`);
      return "busy";
    }
    await page.waitForTimeout(Math.max(25, QUIET_WINDOW_MS - Math.max(0, state.idle)));
  }
}

/** The DOM mutations a page has seen so far (a page that changed after its judgement is judged again). */
export async function mutationsOf(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __renderedQuiet?: { mutations: number } }).__renderedQuiet?.mutations ?? 0);
}

/** How a judgement leaves the page: the media, motion, viewport and scheme to put back (the capture's own). */
export type RenderRestore = Readonly<{ media: "screen" | "print"; reducedMotion: "reduce" | "no-preference"; colorScheme: "light" | "dark"; viewport: Readonly<{ width: number; height: number }> | null }>;

/**
 * Every page row of `surface`, in every render state of `surface`, each once
 * the page is quiet; then the page is put back as `restore` says. Returns the
 * findings, each naming its state and rule, the states that never went quiet,
 * and the mutation count it ended on (for `judgeAgainIfChanged`).
 */
export async function judgeStates(page: Page, surface: Surface, restore: RenderRestore | null, rules?: readonly PageRule[], states: readonly RenderState[] = statesOf(surface)): Promise<{ findings: readonly string[]; busy: readonly string[]; mutations: number }> {
  const findings: string[] = [];
  const busy: string[] = [];
  for (const state of states) {
    await enter(page, state);
    if ((await settle(page)) === "busy") busy.push(state.id);
    for (const finding of await judgePage(page, surface, rules)) findings.push(`(${state.id}) ${finding}`);
  }
  if (restore !== null) {
    if (restore.viewport !== null) await page.setViewportSize({ ...restore.viewport });
    await page.emulateMedia({ media: restore.media, reducedMotion: restore.reducedMotion, colorScheme: restore.colorScheme });
    await settle(page);
  }
  return { findings, busy, mutations: await mutationsOf(page) };
}

/** Before a page is left: if it changed since `mutations`, its rows are judged again, as it now stands. */
export async function judgeAgainIfChanged(page: Page, surface: Surface, mutations: number, rules?: readonly PageRule[]): Promise<readonly string[]> {
  await settle(page);
  if ((await mutationsOf(page)) === mutations) return [];
  return (await judgePage(page, surface, rules)).map((finding) => `(after its judgement) ${finding}`);
}

const statesOf = (surface: Surface): readonly RenderState[] => RENDER_STATES.filter((s) => s.surfaces.includes(surface));

async function enter(page: Page, state: RenderState): Promise<void> {
  if (state.viewport !== undefined) await page.setViewportSize({ ...state.viewport });
  await page.emulateMedia({ media: state.media, reducedMotion: state.reducedMotion, ...(state.colorScheme === undefined ? {} : { colorScheme: state.colorScheme }) });
}

const TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
});

/** A static server for a built site under its base path, on a free loopback port. */
export async function serveSite(siteRoot: string, baseurl: string): Promise<{ server: Server; origin: string }> {
  const root = resolve(siteRoot);
  const base = baseurl.replace(/\/+$/u, "");
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://site").pathname);
    if (!path.startsWith(`${base}/`) && path !== base) { response.writeHead(404).end(); return; }
    let file = resolve(join(root, path.slice(base.length)));
    if (file !== root && !file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
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
      else if (name.endsWith(".html")) pages.push(`${base}/${relative(siteRoot, path).split(sep).join("/")}`.replace(/(?:^|\/)index\.html$/u, "/"));
    }
  };
  walk(siteRoot);
  return pages;
}

/** Judges every page of a built site in every site render state; returns the findings, each with its page. */
async function judgeSite(siteRoot: string, baseurl: string, executable: string | null): Promise<readonly string[]> {
  if (!existsSync(siteRoot)) throw new RenderedRefusal("rendered_site_missing", `${siteRoot} is not a built site`);
  const pages = sitePages(siteRoot, baseurl);
  if (pages.length === 0) throw new RenderedRefusal("rendered_site_empty", `${siteRoot} holds no HTML page`);
  const { server, origin } = await serveSite(siteRoot, baseurl);
  const browser = await launchBrowser(executable);
  const findings = new Set<string>();
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    let current = "";
    await instrumentContext(context, "site", origin, (finding) => findings.add(`${current}: ${finding}`));
    const page = await context.newPage();
    for (const path of pages) {
      current = path;
      await page.goto(`${origin}${path}`, { waitUntil: "load" });
      const judged = await judgeStates(page, "site", null);
      for (const finding of judged.findings) findings.add(`${path} ${finding}`);
      for (const state of judged.busy) findings.add(`${path} (${state}): the page never went quiet within ${SETTLE_LIMIT_MS} ms (requests, short timers or DOM mutations kept coming)`);
      for (const finding of await judgeAgainIfChanged(page, "site", judged.mutations)) findings.add(`${path} ${finding}`);
    }
    await context.close();
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
  process.stdout.write(`${JSON.stringify({ surface: "site", pages, rules: RENDERED_RULES.filter((r) => r.surfaces.includes("site")).map((r) => r.id), pending, findings: findings.length })}\n`);
  return findings.length === 0 ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`[rendered] REFUSED ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
