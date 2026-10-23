/**
 * THE RENDERED JUDGEMENT — runs the one rule table (rules.ts) against pages a
 * real browser has rendered. Two callers, one runner:
 *
 *   - the cockpit: the capture walk (scripts/capture/cockpit.ts) calls
 *     `judgePage` on every view it reaches and `watchRequests` on every
 *     browser context; `--judge-only` is that walk without images (CI);
 *   - the site: `node scripts/rendered/judge.ts site --site <built site>
 *     --baseurl <base path>` serves a built site on loopback and judges every
 *     HTML page it holds, in both of the site's themes.
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
import { SITE_THEME_STORAGE } from "../../shared/site-page.ts";
import { RENDERED_RULES, type PageRule, type RequestRule, type Surface } from "./rules.ts";

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

/**
 * Instruments `context` for the table, once, before any page opens: every
 * request rule of `surface` sees every request, and every page records its
 * Content-Security-Policy violations from the first byte (the csp-violations
 * row reads them).
 */
export async function instrumentContext(context: BrowserContext, surface: Surface, origin: string, report: (finding: string) => void): Promise<void> {
  await context.addInitScript(() => {
    const seen: { directive: string; blocked: string }[] = [];
    (window as unknown as { __renderedCspViolations: typeof seen }).__renderedCspViolations = seen;
    document.addEventListener("securitypolicyviolation", (event) => { seen.push({ directive: event.violatedDirective, blocked: event.blockedURI }); });
  });
  const rules = requestRules(surface);
  context.on("request", (request) => {
    for (const rule of rules) {
      const finding = rule.judge(request.url(), request.resourceType(), origin);
      if (finding !== null) report(`[${rule.id}] ${finding}`);
    }
  });
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

/** Judges every page of a built site in both of its themes; returns the findings, each with its page. */
async function judgeSite(siteRoot: string, baseurl: string, executable: string | null): Promise<readonly string[]> {
  if (!existsSync(siteRoot)) throw new RenderedRefusal("rendered_site_missing", `${siteRoot} is not a built site`);
  const pages = sitePages(siteRoot, baseurl);
  if (pages.length === 0) throw new RenderedRefusal("rendered_site_empty", `${siteRoot} holds no HTML page`);
  const { server, origin } = await serveSite(siteRoot, baseurl);
  const browser = await launchBrowser(executable);
  const findings = new Set<string>();
  try {
    // The site's two themes: Logbook leads (nothing stored), Carbon is the
    // reader's stored choice (shared/site-page.ts SITE_THEME_STORAGE); the
    // site does not follow the system scheme.
    for (const scheme of ["logbook", "carbon"] as const) {
      const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });
      await context.addInitScript(({ key, value, stored }) => {
        try {
          if (stored) localStorage.setItem(key, value);
          else localStorage.removeItem(key);
        } catch { /* a page without storage shows the lead theme */ }
      }, { key: SITE_THEME_STORAGE.key, value: SITE_THEME_STORAGE.carbon, stored: scheme === "carbon" });
      let current = "";
      await instrumentContext(context, "site", origin, (finding) => findings.add(`${current} (${scheme}): ${finding}`));
      const page = await context.newPage();
      for (const path of pages) {
        current = path;
        await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        for (const finding of await judgePage(page, "site")) findings.add(`${path} (${scheme}): ${finding}`);
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
