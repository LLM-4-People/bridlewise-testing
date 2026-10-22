/**
 * THE RENDERED RULES' OWN PROOF — run in the browser job before the judgement
 * it backs: a fixture site where one page holds every rule and each other page
 * plants one break, in a spelling a static guard could miss. Every plant must
 * be caught, by the rule that owns it, and the clean page must pass.
 *
 *   node scripts/rendered/proof.ts
 *
 * Exits 1, naming each plant that passed or the clean page's findings.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright-core";

import { isEntryPoint } from "../../engine/src/runtime/cli-debug.ts";
import { BRAND_MARK, strokePath } from "../../src/cockpit/shell/brand-mark.ts";
import { judgePage, serveSite, watchRequests } from "./judge.ts";

/** The mark as Brand.svelte draws it, from the one geometry and its tokens (never a copy of its coordinates). */
function markSvg(): string {
  const g = BRAND_MARK.grid;
  const stroke = (s: typeof BRAND_MARK.rein): string => `<path d="${strokePath(s)}" stroke-width="${BRAND_MARK.stroke}" style="stroke: var(${s.ink})"></path>`;
  return [
    `<svg viewBox="0 0 ${g} ${g}" role="img" aria-label="Bridlewise">`,
    `<rect width="${g}" height="${g}" rx="${BRAND_MARK.tileRadius}" style="fill: var(${BRAND_MARK.tile})"></rect>`,
    stroke(BRAND_MARK.rein),
    ...BRAND_MARK.lines.map(stroke),
    `<circle cx="${BRAND_MARK.beam.at[0]}" cy="${BRAND_MARK.beam.at[1]}" r="${BRAND_MARK.beam.r}" style="fill: var(${BRAND_MARK.beam.ink})"></circle>`,
    `</svg>`,
  ].join("\n");
}

/** The clean page: the token stacks, a brand mark painted from its tokens, text in the stacks. */
const CLEAN = `<!doctype html><html><head><meta charset="utf-8"><title>clean</title>
<style>
:root { --face-sans: "Proof Sans", sans-serif; --face-mono: "Proof Mono", monospace; --ground-0: #101216; --ink-1: #e8ebef; --ink-2: #a6adb8; --beam: #8fd3ff; }
body { font-family: var(--face-sans); }
:where(code, kbd, samp, pre) { font-family: var(--face-mono); }
.brand svg { width: 32px; height: 32px; display: block; }
.brand path { fill: none; }
</style><!--PLANT-HEAD--></head>
<body><header><span class="brand">${markSvg()}</span></header>
<main><p id="prose">A sentence in the sans stack.</p><p>Inline <code>code</code> in the mono stack.</p></main><!--PLANT-BODY--></body></html>`;

type Plant = Readonly<{ name: string; head?: string; body?: string; rule: string }>;

/** Each break, and the rule that must name it. */
const PLANTS: readonly Plant[] = [
  { name: "a part hidden from another stylesheet, by element", head: "<style>svg circle { opacity: 0 }</style>", rule: "brand-mark" },
  { name: "a part filtered through :where", head: "<style>:where(svg) rect { filter: invert(1) }</style>", rule: "brand-mark" },
  { name: "a part recoloured through an attribute selector", head: '<style>[class~="brand"] path { stroke: red !important }</style>', rule: "brand-mark" },
  { name: "the mark hidden by its ancestor", head: "<style>header { visibility: hidden }</style>", rule: "brand-mark" },
  { name: "the mark clipped to nothing", head: "<style>.brand svg { clip-path: inset(50%) }</style>", rule: "brand-mark" },
  { name: "a part added", body: '<script>document.querySelector(".brand svg").append(document.createElementNS("http://www.w3.org/2000/svg", "line"))</script>', rule: "brand-mark" },
  { name: "a family appended to the token", head: "<style>#prose { font-family: var(--face-sans), Georgia }</style>", rule: "font-families" },
  { name: "the browser's monospace left on code", head: "<style>code { font-family: revert }</style>", rule: "font-families" },
  { name: "a family set by style.fontFamily", body: '<script>document.getElementById("prose").style.fontFamily = "Georgia"</script>', rule: "font-families" },
  { name: "a family set by a style attribute", body: '<script>document.getElementById("prose").setAttribute("style", "font-family: Georgia")</script>', rule: "font-families" },
  { name: "a family set by an inserted stylesheet", body: '<script>const s = document.createElement("style"); s.textContent = "#prose{font-family:Georgia}"; document.head.append(s)</script>', rule: "font-families" },
  { name: "a family set through the CSSOM", body: '<script>document.styleSheets[0].insertRule("#prose { font-family: Georgia }", 0)</script>', rule: "font-families" },
  { name: "a remote stylesheet whose URL has no .css", head: '<link rel="stylesheet" href="https://cdn.example.invalid/type?family=Inter">', rule: "same-origin" },
  { name: "a remote font through @import", head: '<style>@import url("https://fonts.example.invalid/face");</style>', rule: "same-origin" },
  { name: "a remote font face", head: '<style>@font-face { font-family: "Proof Sans"; src: url("https://fonts.example.invalid/proof.woff2") } </style>', rule: "same-origin" },
  { name: "a remote script", head: '<script src="https://cdn.example.invalid/loader.js"></script>', rule: "same-origin" },
];

/** Builds the fixture site, judges every page as the cockpit is judged (every rule), and returns what failed. */
async function prove(): Promise<readonly string[]> {
  const dir = mkdtempSync(join(tmpdir(), "rendered-proof-"));
  const failures: string[] = [];
  try {
    writeFileSync(join(dir, "clean.html"), CLEAN);
    PLANTS.forEach((plant, i) => writeFileSync(join(dir, `plant-${i}.html`), CLEAN.replace("<!--PLANT-HEAD-->", plant.head ?? "").replace("<!--PLANT-BODY-->", plant.body ?? "")));
    const { server, origin } = await serveSite(dir, "/proof");
    const browser = await chromium.launch({ headless: true });
    try {
      const judge = async (file: string): Promise<readonly string[]> => {
        const context = await browser.newContext({ serviceWorkers: "block" });
        const requests: string[] = [];
        watchRequests(context, "cockpit", origin, (finding) => requests.push(finding));
        const page = await context.newPage();
        await page.goto(`${origin}/proof/${file}`, { waitUntil: "load" });
        await page.waitForTimeout(300);
        const findings = [...(await judgePage(page, "cockpit")), ...requests];
        await context.close();
        return findings;
      };
      const clean = await judge("clean.html");
      if (clean.length > 0) failures.push(`the clean page is not clean:\n    ${clean.join("\n    ")}`);
      for (const [i, plant] of PLANTS.entries()) {
        const findings = await judge(`plant-${i}.html`);
        if (!findings.some((f) => f.startsWith(`[${plant.rule}]`))) failures.push(`${plant.name}: not caught by ${plant.rule} (found: ${findings.join("; ") || "nothing"})`);
      }
    } finally {
      await browser.close();
      await new Promise<void>((done) => server.close(() => done()));
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
  return failures;
}

if (isEntryPoint(import.meta.url)) {
  prove().then((failures) => {
    for (const failure of failures) process.stdout.write(`${failure}\n`);
    process.stdout.write(`${JSON.stringify({ plants: PLANTS.length, caught: PLANTS.length - failures.filter((f) => !f.startsWith("the clean page")).length, cleanPagePasses: !failures.some((f) => f.startsWith("the clean page")) })}\n`);
    process.exitCode = failures.length === 0 ? 0 : 1;
  }, (error: unknown) => {
    process.stderr.write(`[rendered] REFUSED ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
