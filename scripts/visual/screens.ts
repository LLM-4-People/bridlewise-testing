/**
 * THE VISUAL REGRESSION CHECK — the key pages of two built sites (a base
 * commit and a head commit), shot by one browser in one run and compared
 * byte for byte (`plan.ts` declares the matrix and the judgements).
 *
 *   node scripts/visual/screens.ts --base <built site> --head <built site>
 *        --baseurl <base path> --out <report dir> [--change-declared]
 *
 * For every page × theme × viewport it:
 * - shoots the head twice; two different pictures of one page is a
 *   nondeterministic render (`unstable`), never a pass;
 * - shoots the base once, with the same volatile regions masked;
 * - compares the PNG bytes; only a difference is decoded (in the browser's
 *   own canvas, no image library) to count the changed pixels and paint a
 *   diff;
 * - measures the head page's invariants: no sideways scroll, a load that
 *   shifts the layout less than the budget, the faces actually loaded,
 *   alt text, one main, one h1.
 *
 * It writes `<out>/report.html` (side by side, with diffs), `<out>/summary.md`
 * (the job summary) and `<out>/result.json`, and exits 1 when the gate
 * refuses. Refusals are typed (`visual_*`).
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { escapeHtml } from "../../shared/markup.ts";
import { BROWSER_ARGS, FREEZE_CSS, gate, invariantViolations, shotName, shots, THEME_STORAGE, VOLATILE_SELECTORS, type Comparison, type PageFacts, type Shot } from "./plan.ts";

export class VisualRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".ico": "image/x-icon",
});

/** A static server for a built site under its base path, on a free loopback port. */
async function serve(siteRoot: string, baseurl: string): Promise<{ server: Server; origin: string }> {
  const base = baseurl.replace(/\/+$/u, "");
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://site").pathname);
    if (!path.startsWith(`${base}/`) && path !== base) { response.writeHead(404).end(); return; }
    let file = join(siteRoot, path.slice(base.length));
    if (!file.startsWith(siteRoot)) { response.writeHead(403).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new VisualRefusal("visual_server_failed", "the static server has no port");
  return { server, origin: `http://127.0.0.1:${String(address.port)}` };
}

async function context(browser: Browser, shot: Shot): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport: { width: shot.viewport.width, height: shot.viewport.height }, deviceScaleFactor: 1, reducedMotion: "reduce", colorScheme: "light" });
  await ctx.addInitScript(({ key, value, carbon }) => {
    try {
      if (carbon) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch { /* a page without storage leads in Logbook */ }
    // The load's layout shifts, read after the page settles.
    (globalThis as unknown as { __shift: number }).__shift = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
        if (!entry.hadRecentInput) (globalThis as unknown as { __shift: number }).__shift += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  }, { key: THEME_STORAGE.key, value: THEME_STORAGE.carbon, carbon: shot.theme === "carbon" });
  return ctx;
}

async function settle(page: Page, url: string): Promise<void> {
  const response = await page.goto(url, { waitUntil: "networkidle" });
  if (response === null || !response.ok()) throw new VisualRefusal("visual_page_missing", `${url} answered ${String(response?.status() ?? "nothing")}`);
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(async () => { await document.fonts.ready; });
}

async function facts(page: Page): Promise<PageFacts> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    layoutShift: (globalThis as unknown as { __shift: number }).__shift,
    fontsLoaded: [...new Set([...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replace(/^"|"$/gu, "")))],
    imagesWithoutAlt: document.querySelectorAll("img:not([alt])").length,
    mains: document.querySelectorAll("main").length,
    h1s: document.querySelectorAll("h1").length,
  }));
}

async function picture(page: Page): Promise<Buffer> {
  const masks = page.locator(VOLATILE_SELECTORS.join(", "));
  return page.screenshot({ fullPage: true, animations: "disabled", mask: [masks], maskColor: "#808080" });
}

/** Changed pixels between two PNGs, counted (and a diff painted) in the browser's canvas. */
async function difference(page: Page, before: Buffer, after: Buffer): Promise<{ changed: number; total: number; diff: string }> {
  return page.evaluate(async ([a, b]) => {
    const load = async (data: string): Promise<ImageBitmap> => createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const [left, right] = [await load(a!), await load(b!)];
    const width = Math.max(left.width, right.width);
    const height = Math.max(left.height, right.height);
    const read = (image: ImageBitmap): Uint8ClampedArray => {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, width, height).data;
    };
    const [p, q] = [read(left), read(right)];
    const out = new OffscreenCanvas(width, height);
    const octx = out.getContext("2d")!;
    const diff = octx.createImageData(width, height);
    let changed = 0;
    for (let i = 0; i < p.length; i += 4) {
      const same = p[i] === q[i] && p[i + 1] === q[i + 1] && p[i + 2] === q[i + 2] && p[i + 3] === q[i + 3];
      if (!same) changed += 1;
      // Unchanged pixels are a faint ghost of the head; changed ones are solid.
      diff.data[i] = same ? 255 - (255 - q[i]!) / 6 : 214;
      diff.data[i + 1] = same ? 255 - (255 - q[i + 1]!) / 6 : 40;
      diff.data[i + 2] = same ? 255 - (255 - q[i + 2]!) / 6 : 40;
      diff.data[i + 3] = 255;
    }
    octx.putImageData(diff, 0, 0);
    const blob = await out.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { changed, total: width * height, diff: btoa(binary) };
  }, [before.toString("base64"), after.toString("base64")]);
}

export interface RunOptions {
  readonly base: string;
  readonly head: string;
  readonly baseurl: string;
  readonly out: string;
  readonly changeDeclared: boolean;
  readonly pages?: readonly string[] | undefined;
}

/** The whole check (see the header): the comparisons and the gate's answer. */
export async function run(options: RunOptions): Promise<Readonly<{ comparisons: readonly Comparison[]; pass: boolean; reasons: readonly string[] }>> {
  for (const [name, root] of [["base", options.base], ["head", options.head]] as const) {
    if (!existsSync(join(root, "index.html"))) throw new VisualRefusal("visual_site_missing", `the ${name} site at ${root} is not a built site (no index.html); build it with scripts/build-site.mjs first`);
  }
  mkdirSync(join(options.out, "shots"), { recursive: true });
  const base = await serve(resolve(options.base), options.baseurl);
  const head = await serve(resolve(options.head), options.baseurl);
  const browser = await chromium.launch({ args: [...BROWSER_ARGS] });
  const prefix = options.baseurl.replace(/\/+$/u, "");
  const comparisons: Comparison[] = [];
  const differ = await browser.newPage();
  try {
    for (const shot of shots(options.pages)) {
      const name = shotName(shot);
      const ctx = await context(browser, shot);
      const page = await ctx.newPage();
      await settle(page, `${head.origin}${prefix}${shot.page}`);
      const pageFacts = await facts(page);
      const first = await picture(page);
      await settle(page, `${head.origin}${prefix}${shot.page}`);
      const second = await picture(page);
      let before: Buffer | null = null;
      try {
        await settle(page, `${base.origin}${prefix}${shot.page}`);
        before = await picture(page);
      } catch (error) {
        if (!(error instanceof VisualRefusal && error.code === "visual_page_missing")) throw error;
      }
      await ctx.close();
      const invariants = invariantViolations(pageFacts);
      // Only a shot that needs a reader's eyes is kept: an unchanged, sound
      // page has nothing to show.
      if (before === null || !before.equals(first) || !first.equals(second) || invariants.length > 0) {
        writeFileSync(join(options.out, "shots", `head--${name}`), first);
        if (before !== null) writeFileSync(join(options.out, "shots", `base--${name}`), before);
      }
      if (!first.equals(second)) {
        comparisons.push({ name, verdict: "unstable", changedPixels: 0, totalPixels: 0, invariants });
      } else if (before === null) {
        comparisons.push({ name, verdict: "added", changedPixels: 0, totalPixels: 0, invariants });
      } else if (before.equals(first)) {
        comparisons.push({ name, verdict: "same", changedPixels: 0, totalPixels: 0, invariants });
      } else {
        const { changed, total, diff } = await difference(differ, before, first);
        writeFileSync(join(options.out, "shots", `diff--${name}`), Buffer.from(diff, "base64"));
        comparisons.push({ name, verdict: changed === 0 ? "same" : "changed", changedPixels: changed, totalPixels: total, invariants });
      }
    }
  } finally {
    await browser.close();
    base.server.close();
    head.server.close();
  }
  const verdict = gate(comparisons, { changeDeclared: options.changeDeclared });
  writeFileSync(join(options.out, "result.json"), `${JSON.stringify({ schema: "bridlewise-visual-check/v1", ...verdict, comparisons }, null, 2)}\n`);
  writeFileSync(join(options.out, "summary.md"), summary(comparisons, verdict));
  writeFileSync(join(options.out, "report.html"), report(comparisons, verdict));
  return { comparisons, ...verdict };
}

function summary(comparisons: readonly Comparison[], verdict: { pass: boolean; reasons: readonly string[] }): string {
  const count = (v: Comparison["verdict"]): number => comparisons.filter((c) => c.verdict === v).length;
  const rows = comparisons.filter((c) => c.verdict !== "same" || c.invariants.length > 0).map((c) =>
    `| \`${c.name}\` | ${c.verdict} | ${c.totalPixels === 0 ? "" : `${(100 * c.changedPixels / c.totalPixels).toFixed(2)}%`} | ${c.invariants.join("; ")} |`);
  return [
    `### Visual regression: ${verdict.pass ? "pass" : "refused"}`,
    "",
    `${String(comparisons.length)} shots · ${String(count("same"))} same · ${String(count("changed"))} changed · ${String(count("added"))} added · ${String(count("unstable"))} unstable. The report (side by side, with diffs) is the run's \`visual-report\` artifact.`,
    "",
    ...(verdict.reasons.length === 0 ? [] : ["**Why it refuses:**", "", ...verdict.reasons.map((reason) => `- ${reason}`), ""]),
    ...(rows.length === 0 ? [] : ["| Shot | Verdict | Pixels changed | Invariants broken |", "|---|---|---|---|", ...rows, ""]),
  ].join("\n");
}

function report(comparisons: readonly Comparison[], verdict: { pass: boolean; reasons: readonly string[] }): string {
  const h = escapeHtml;
  const card = (c: Comparison): string => {
    const images = c.verdict === "changed"
      ? ["base", "head", "diff"].map((kind) => `<figure><img loading="lazy" alt="${h(`${kind}: ${c.name}`)}" src="shots/${kind}--${h(c.name)}"><figcaption>${kind}</figcaption></figure>`).join("")
      : `<figure><img loading="lazy" alt="${h(`head: ${c.name}`)}" src="shots/head--${h(c.name)}"><figcaption>head</figcaption></figure>`;
    return `<section data-verdict="${h(c.verdict)}"><h2>${h(c.name)} <small>${h(c.verdict)}${c.totalPixels === 0 ? "" : ` · ${(100 * c.changedPixels / c.totalPixels).toFixed(2)}% of pixels`}</small></h2>${c.invariants.length === 0 ? "" : `<ul>${c.invariants.map((i) => `<li>${h(i)}</li>`).join("")}</ul>`}<div class="row">${images}</div></section>`;
  };
  const ordered = comparisons.filter((c) => c.verdict !== "same" || c.invariants.length > 0);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Visual regression report</title>
<style>body{margin:0 auto;max-width:1600px;padding:24px;font:15px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}section{border-top:1px solid GrayText;padding:16px 0}small{font-weight:400;color:GrayText}.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;align-items:start}img{width:100%;height:auto;border:1px solid GrayText}figure{margin:0}</style></head>
<body><h1>Visual regression: ${verdict.pass ? "pass" : "refused"}</h1><p>${String(comparisons.length)} shots; ${String(comparisons.length - ordered.length)} unchanged and sound (not shown).</p>${verdict.reasons.length === 0 ? "" : `<ul>${verdict.reasons.map((r) => `<li>${h(r)}</li>`).join("")}</ul>`}${ordered.map(card).join("")}</body></html>
`;
}

async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { base: { type: "string" }, head: { type: "string" }, baseurl: { type: "string" }, out: { type: "string" }, "change-declared": { type: "boolean", default: false }, page: { type: "string", multiple: true } },
  });
  if (values.base === undefined || values.head === undefined || values.baseurl === undefined || values.out === undefined) {
    throw new VisualRefusal("visual_usage", "usage: screens.ts --base <site> --head <site> --baseurl <base path> --out <dir> [--change-declared] [--page <path>]…");
  }
  const result = await run({ base: values.base, head: values.head, baseurl: values.baseurl, out: values.out, changeDeclared: values["change-declared"] ?? false, pages: values.page });
  process.stdout.write(readFileSync(join(values.out, "summary.md"), "utf8"));
  return result.pass ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`visual check failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
