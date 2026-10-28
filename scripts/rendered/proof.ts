/**
 * THE RENDERED RULES' OWN PROOF — run in the browser job before the judgement
 * it backs: a fixture site where one page holds every rule and each other page
 * plants one break, in a spelling a static guard could miss. Every plant must
 * be caught, by the rule that owns it, and the clean page must pass.
 *
 *   node scripts/rendered/proof.ts [--browser <executable>]
 *
 * Exits 1, naming each plant that passed or the clean page's findings.
 */
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "node:util";

import { bootstrapProcess, isEntryPoint } from "../../engine/src/runtime/cli-debug.ts";
import { BRAND_MARK, strokePath } from "../../src/cockpit/shell/brand-mark.ts";
import { instrumentContext, judgeFuture, judgeStates, launchBrowser, navigate, openPage, serveSite, siteRestore } from "./judge.ts";
import { tokenValues } from "../token-owner.ts";
import { vendoredFaces } from "../vendor-fonts.ts";
import { CONTENT_SECURITY_POLICY, JUDGE_LIMITS, RENDER_STATES, RENDERED_RULES, type PageRule } from "./rules.ts";

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

/** The tokens the clean page wears, each with the token owner's own value (scripts/token-owner.ts): the face stacks and the mark's colours. */
const MARK_TOKENS = [...new Set([BRAND_MARK.tile, BRAND_MARK.rein.ink, ...BRAND_MARK.lines.map((line) => line.ink), BRAND_MARK.beam.ink])];
const OWNER = tokenValues("carbon", ["--face-sans", "--face-mono", ...MARK_TOKENS]);
const LOGBOOK = tokenValues("logbook", MARK_TOKENS);
const declarations = (values: Readonly<Record<string, string>>): string => Object.entries(values).map(([name, value]) => `${name}: ${value};`).join(" ");
/** The owner's sans stack, its first family, and its mono stack, as a canvas font names them. */
const SANS_FAMILY = OWNER["--face-sans"]!.split(",")[0]!.trim().replace(/^"|"$/gu, "");

/** The font owner's vendored faces (scripts/vendor-fonts.ts): the sans family's own file and another family's, served as the cockpit serves them. */
const FACES = vendoredFaces();
const SANS_FILE = FACES.find((face) => face.family === SANS_FAMILY)?.files[0];
const OTHER_FILE = FACES.find((face) => face.family !== SANS_FAMILY)?.files[0];
if (SANS_FILE === undefined || OTHER_FILE === undefined) throw new Error(`[rendered] the font owner vendors no file for ${SANS_FAMILY}, or no other family`);
const PUBLIC = resolve(fileURLToPath(new URL("../../public", import.meta.url)));
const servedFont = (path: string) => (response: ServerResponse): void => {
  response.writeHead(200, { "content-type": "font/woff2" });
  createReadStream(join(PUBLIC, path)).pipe(response);
};
const vendoredFace = (file: string): string => `<style>@font-face { font-family: "${SANS_FAMILY}"; src: url("${file}") format("woff2") }</style>`;
const canvasFont = (token: "--face-sans" | "--face-mono"): string => `12px ${OWNER[token]!}`;

/** The clean page: the owner's token values, a brand mark painted from its tokens, text in the stacks. */
const CLEAN = `<!doctype html><html><head><meta charset="utf-8"><title>clean</title>
<style>
:root { ${declarations(OWNER)} }
body { font-family: var(--face-sans); }
:where(code, kbd, samp, pre) { font-family: var(--face-mono); }
button, input, textarea, select { font: inherit; }
.brand svg { width: 32px; height: 32px; display: block; }
.brand path { fill: none; }
</style><!--PLANT-HEAD--></head>
<body><header><span class="brand">${markSvg()}</span></header>
<main><p id="prose">A sentence in the sans stack.</p><p>Inline <code>code</code> in the mono stack.</p></main><!--PLANT-BODY--></body></html>`;

/** A page: what it adds to the clean one, and the rule that must name it. `only` judges it with exactly those rows (a row pending on every surface is proved this way). */
type Plant = Readonly<{ name: string; head?: string; body?: string; rule: string; only?: readonly string[] }>;

const cspMeta = (policy: string): string => `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
/** A script that runs `body` in a dedicated worker. */
const inWorker = (body: string): string => `<script>new Worker(URL.createObjectURL(new Blob([${JSON.stringify(body)}], { type: "text/javascript" })))</script>`;
/** A script that runs `body` once `delay` ms of page time have passed. */
const later = (delay: number, body: string): string => `<script>setTimeout(() => { ${body} }, ${delay})</script>`;
const GEORGIA_RULE = 'document.styleSheets[0].insertRule("#prose { font-family: Georgia }", 0)';

/** The proof's slow but steady stylesheet: a comment line every STEADY_EVERY_MS for STEADY_FOR_MS, then a rule that changes nothing. */
const STEADY_PATH = "/proof/steady.css";
const STEADY_FOR_MS = 35_000;
const STEADY_EVERY_MS = 500;
function steady(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/css; charset=utf-8" });
  let sent = 0;
  const tick = setInterval(() => {
    sent += STEADY_EVERY_MS;
    if (sent < STEADY_FOR_MS) { response.write(`/* ${String(sent)} ms */\n`); return; }
    clearInterval(tick);
    response.end("#prose { font-family: var(--face-sans); }\n");
  }, STEADY_EVERY_MS);
  response.on("close", () => clearInterval(tick));
}

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
  { name: "a remote font face", head: `<style>@font-face { font-family: "${SANS_FAMILY}"; src: url("https://fonts.example.invalid/proof.woff2") } </style>`, rule: "same-origin" },
  { name: "a remote script", head: '<script src="https://cdn.example.invalid/loader.js"></script>', rule: "same-origin" },
  { name: "a canvas font set by assignment", body: '<canvas id="c"></canvas><script>document.getElementById("c").getContext("2d").font = "12px Georgia"</script>', rule: "font-families" },
  { name: "a canvas font set by a bracketed key", body: '<canvas id="c"></canvas><script>document.getElementById("c").getContext("2d")["font"] = "bold 14px Georgia"</script>', rule: "font-families" },
  { name: "a canvas font set through Object.assign", body: '<canvas id="c"></canvas><script>Object.assign(document.getElementById("c").getContext("2d"), { font: "12px Georgia" })</script>', rule: "font-families" },
  { name: "a canvas font appended with +=", body: '<canvas id="c"></canvas><script>const x = document.getElementById("c").getContext("2d"); x.font += ", Georgia"</script>', rule: "font-families" },
  { name: "an offscreen canvas font", body: '<script>new OffscreenCanvas(10, 10).getContext("2d").font = "12px Georgia"</script>', rule: "font-families" },
  { name: "a family a script adds 1.5 s after load", body: '<script>setTimeout(() => { const s = document.createElement("style"); s.textContent = "#prose{font-family:Georgia}"; document.head.append(s); }, 1500)</script>', rule: "font-families" },
  { name: "a remote stylesheet a script adds 1.5 s after load", body: '<script>setTimeout(() => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "https://cdn.example.invalid/late"; document.head.append(l); }, 1500)</script>', rule: "same-origin" },
  { name: "the mark hidden only at a narrow width", head: "<style>@media (max-width: 600px) { .brand svg { display: none } }</style>", rule: "brand-mark" },
  { name: "a part hidden only in print", head: "<style>@media print { svg circle { opacity: 0 } }</style>", rule: "brand-mark" },
  { name: "a family only under reduced motion", head: "<style>@media (prefers-reduced-motion: reduce) { #prose { font-family: Georgia } }</style>", rule: "font-families" },
  // What happens later — each caught only because the page's future is run (judgeFuture), however it was scheduled.
  { name: "a family an interval sets on its third tick", body: `<script>let n = 0; const t = setInterval(() => { if (++n === 3) { clearInterval(t); ${GEORGIA_RULE}; } }, 2100)</script>`, rule: "font-families" },
  { name: "the beam hidden on an interval's third tick", body: '<script>let n = 0; const t = setInterval(() => { if (++n === 3) { clearInterval(t); document.styleSheets[0].insertRule("svg circle { opacity: 0 }", 0); } }, 2100)</script>', rule: "brand-mark" },
  { name: "a family a timer adds 20 s after load, through the CSSOM", body: later(20_000, GEORGIA_RULE), rule: "font-families" },
  { name: "a stylesheet a timer appends 20 s after load", body: later(20_000, 'const s = document.createElement("style"); s.textContent = "#prose{font-family:Georgia}"; document.head.append(s);'), rule: "font-families" },
  { name: "a rule's own declaration changed through the CSSOM 3 s after load", body: later(3000, 'document.styleSheets[0].cssRules[1].style.fontFamily = "Georgia";'), rule: "font-families" },
  { name: "a family a string-handler timer sets", body: `<script>setTimeout("document.getElementById('prose').style.fontFamily = 'Georgia'", 4000)</script>`, rule: "font-families" },
  { name: "a family set after 300 animation frames", body: `<script>let f = 0; const step = () => { if (++f === 300) ${GEORGIA_RULE}; else requestAnimationFrame(step); }; requestAnimationFrame(step)</script>`, rule: "font-families" },
  { name: "a family an animation sets after a 6 s delay", head: "<style>@keyframes late { to { font-family: Georgia } } #prose { animation: late 1ms 6s forwards }</style>", rule: "font-families" },
  { name: "a family set when the page leaves its narrow state", body: `<script>matchMedia("(max-width: 600px)").addEventListener("change", (e) => { if (!e.matches) ${GEORGIA_RULE}; })</script>`, rule: "font-families" },
  // Other realms: frames, shadow roots, workers.
  { name: "a worker that draws and ends at once", body: inWorker('new OffscreenCanvas(10, 10).getContext("2d").font = "12px Georgia"; close();'), rule: "judgeable" },
  { name: "a shared worker", body: `<script>new SharedWorker(URL.createObjectURL(new Blob(["onconnect = () => {}"], { type: "text/javascript" })))</script>`, rule: "judgeable" },
  { name: "a canvas font set through another frame's setter", body: '<canvas id="c"></canvas><script>const f = document.createElement("iframe"); document.body.append(f); Object.getOwnPropertyDescriptor(f.contentWindow.CanvasRenderingContext2D.prototype, "font").set.call(document.getElementById("c").getContext("2d"), "12px Georgia"); f.remove();</script>', rule: "font-families" },
  { name: "a canvas font in a frame", body: `<iframe srcdoc="<canvas id=c></canvas><script>document.getElementById('c').getContext('2d').font = '12px Georgia'</script>"></iframe>`, rule: "font-families" },
  { name: "text in a frame", body: `<iframe srcdoc="<p style='font-family: Georgia'>framed text</p>"></iframe>`, rule: "font-families" },
  { name: "text in an open shadow root", body: '<div id="host"></div><script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = "<p style=\'font-family: Georgia\'>shadow text</p>"</script>', rule: "font-families" },
  { name: "a mark in an open shadow root with its beam hidden", body: `<div id="host"></div><script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(`<style>.brand path { fill: none } circle { opacity: 0 }</style><span class="brand">${markSvg()}</span>`)}</script>`, rule: "brand-mark" },
  { name: "a closed shadow root", body: '<div id="host"></div><script>document.getElementById("host").attachShadow({ mode: "closed" }).innerHTML = "<p>closed text</p>"</script>', rule: "judgeable" },
  { name: "a window the page opens", body: '<script>window.open("clean.html")</script>', rule: "judgeable" },
  { name: "a change a delayed scheduler.postTask makes", body: `<script>scheduler.postTask(() => { ${GEORGIA_RULE}; }, { delay: 7000 })</script>`, rule: "judgeable" },
  { name: "a delayed postTask called through the prototype", body: "<script>Scheduler.prototype.postTask.call(scheduler, () => {}, { delay: 1 })</script>", rule: "judgeable" },
  // Faces: bound to the token owner's vendored files, whoever declares them.
  { name: "a token family loaded from another family's vendored file", head: vendoredFace(OTHER_FILE), rule: "font-families" },
  { name: "a token family redefined to a local face", head: `<style>@font-face { font-family: "${SANS_FAMILY}"; src: local("DejaVu Serif"), local("Liberation Serif") }</style>`, rule: "font-families" },
  { name: "a face of another family from a local font", head: '<style>@font-face { font-family: "Shadow Serif"; src: local("DejaVu Serif") }</style>', rule: "font-families" },
  { name: "a face a script makes and never uses", body: "<script>const f = new FontFace(\"Evil\", \"local('DejaVu Serif')\"); document.fonts.add(f); f.load().catch(() => {})</script>", rule: "font-families" },
  { name: "a token family a script makes from another face", body: `<script>const f = new FontFace(${JSON.stringify(SANS_FAMILY)}, "local('DejaVu Serif')"); document.fonts.add(f); f.load().catch(() => {})</script>`, rule: "font-families" },
  // A canvas font is exactly one stack, like an element's.
  { name: "a canvas given only the browser's monospace", body: '<canvas id="c"></canvas><script>document.getElementById("c").getContext("2d").font = "12px monospace"</script>', rule: "font-families" },
  { name: "a canvas given only the browser's sans-serif", body: '<canvas id="c"></canvas><script>document.getElementById("c").getContext("2d").font = "12px sans-serif"</script>', rule: "font-families" },
  { name: "a canvas given a mix of the two stacks", body: `<canvas id="c"></canvas><script>document.getElementById("c").getContext("2d").font = ${JSON.stringify(`12px monospace, "${SANS_FAMILY}"`)}</script>`, rule: "font-families" },
  // The owner's values, not the page's: a token redefined anywhere renders what the owner did not declare.
  { name: "a face token redefined at :root", head: "<style>:root { --face-sans: Georgia }</style>", rule: "font-families" },
  { name: "a frame that redefines the face tokens", body: `<iframe srcdoc="<style>:root { --face-sans: Georgia; --face-mono: Georgia } p { font-family: var(--face-sans) }</style><p>framed text</p>"></iframe>`, rule: "font-families" },
  { name: "the beam's token redefined on the mark", head: "<style>.brand { --beam: var(--ground-0) }</style>", rule: "brand-mark" },
  { name: "the Logbook theme worn with Carbon's colours", body: '<script>document.documentElement.setAttribute("data-cockpit-theme", "light")</script>', rule: "brand-mark" },
  // Text wherever it renders.
  { name: "text in a display:contents element", head: "<style>#prose { display: contents; font-family: Georgia }</style>", rule: "font-families" },
  { name: "a form control's value", body: '<input value="typed" style="font-family: Georgia">', rule: "font-families" },
  { name: "a button input's label", body: '<input type="submit" value="Send" style="font-family: Georgia">', rule: "font-families" },
  { name: "a date input's text", body: '<input type="date" value="2026-10-28" style="font-family: Georgia">', rule: "font-families" },
  { name: "a time input's text", body: '<input type="time" value="13:45" style="font-family: Georgia">', rule: "font-families" },
  { name: "a datetime-local input's text", body: '<input type="datetime-local" value="2026-10-28T13:45" style="font-family: Georgia">', rule: "font-families" },
  { name: "a month input's text", body: '<input type="month" value="2026-10" style="font-family: Georgia">', rule: "font-families" },
  { name: "a week input's text", body: '<input type="week" value="2026-W44" style="font-family: Georgia">', rule: "font-families" },
  { name: "a file input's label", body: '<input type="file" style="font-family: Georgia">', rule: "font-families" },
  { name: "an empty text field (it draws what is typed)", body: '<input type="text" style="font-family: Georgia">', rule: "font-families" },
  { name: "generated ::before content", head: '<style>#prose::before { content: "→ "; font-family: Georgia }</style>', rule: "font-families" },
  { name: "a finite animation in a shadow root", body: `<div id="host"></div><script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = "<style>@keyframes late { to { font-family: Georgia } } p { animation: late 1ms 6s forwards }</style><p>shadow text</p>"</script>`, rule: "font-families" },
  // The states a pointer and a keyboard put elements in.
  { name: "a family only on hover", head: "<style>#prose:hover { font-family: Georgia }</style>", rule: "font-families" },
  { name: "a family only on keyboard focus", head: "<style>#go:focus-visible { font-family: Georgia }</style>", body: '<button id="go">go</button>', rule: "font-families" },
  { name: "the beam hidden on hover of the mark", head: "<style>.brand:hover circle { opacity: 0 }</style>", rule: "brand-mark" },
  { name: "a same-origin frame claiming the artifact attribute", body: `<iframe data-artifact="frame" srcdoc="<p style='font-family: Georgia'>not a user artifact</p>"></iframe>`, rule: "font-families" },
  { name: "a paint worklet", body: `<script>CSS.paintWorklet.addModule(URL.createObjectURL(new Blob(["registerPaint('x', class { paint() {} })"], { type: "text/javascript" })))</script>`, rule: "judgeable" },
  { name: "text drawn in a canvas's default font", body: '<canvas id="c"></canvas><script>document.getElementById("c").getContext("2d").fillText("x", 0, 10)</script>', rule: "font-families" },
  { name: "the Content-Security-Policy meta tag missing", rule: "csp-meta", only: ["csp-meta"] },
  { name: "a loosened Content-Security-Policy", head: cspMeta(`${CONTENT_SECURITY_POLICY.replace("'self'", "'self' 'unsafe-inline'")}`), rule: "csp-meta", only: ["csp-meta"] },
  { name: "a second Content-Security-Policy meta tag", head: `${cspMeta(CONTENT_SECURITY_POLICY)}${cspMeta("default-src *")}`, rule: "csp-meta", only: ["csp-meta"] },
  { name: "a resource the policy blocks", head: cspMeta("default-src 'self' 'unsafe-inline'"), body: '<img alt="" src="https://cdn.example.invalid/pixel.png">', rule: "csp-violations", only: ["csp-violations"] },
];

/** Near-misses each row must pass. */
const CLEAN_TOO: readonly Plant[] = [
  { name: "a token family loaded from its own vendored file", head: vendoredFace(SANS_FILE), rule: "font-families" },
  // A live page replaces nodes while the states are forced (the cockpit's Lens callout did): a node gone between snapshot and force is gone, not a refusal.
  // Every animation frame, as an animated list does (not a task-queue loop as fast as the browser runs it: that hogs the browser itself).
  { name: "a page that keeps replacing its nodes while the states are forced", body: '<ul id="churn"></ul><script>const ul = document.getElementById("churn"); const frame = () => { ul.replaceChildren(...Array.from({ length: 40 }, () => document.createElement("li"))); requestAnimationFrame(frame); }; requestAnimationFrame(frame);</script>', rule: "font-families" },
  // Longer than any default wall limit (Playwright's is 30 s), arriving a little at a time: a slow page is still a page.
  { name: "a page whose stylesheet loads slowly but steadily, for longer than 30 s", head: `<link rel="stylesheet" href="${STEADY_PATH.slice("/proof/".length)}">`, rule: "font-families" },
  { name: "a scheduler.postTask with no delay", body: '<script>scheduler.postTask(() => { document.getElementById("prose").textContent = "posted"; })</script>', rule: "judgeable" },
  { name: "an interval that only changes text", body: '<script>let n = 0; setInterval(() => { document.getElementById("prose").textContent = `tick ${++n}`; }, 500)</script>', rule: "font-families" },
  { name: "an opaque-origin artifact frame the declared exclusion skips", body: `<iframe data-artifact="frame" sandbox="allow-scripts" srcdoc="<p style='font-family: Georgia'>a user's artifact</p><canvas id=c></canvas><script>document.getElementById('c').getContext('2d').font = '12px Georgia'</script>"></iframe>`, rule: "font-families" },
  { name: "a canvas drawing text in a token stack", body: `<canvas id="c"></canvas><script>const x = document.getElementById("c").getContext("2d"); x.font = ${JSON.stringify(canvasFont("--face-sans"))}; x.fillText("x", 0, 10)</script>`, rule: "font-families" },
  { name: "the Logbook theme worn with its own colours", head: `<style>:root[data-cockpit-theme="light"] { ${declarations(LOGBOOK)} }</style>`, body: '<script>document.documentElement.setAttribute("data-cockpit-theme", "light")</script>', rule: "brand-mark" },
  { name: "the input types HTML draws no text for", body: '<input type="checkbox" checked style="font-family: Georgia"><input type="radio" checked style="font-family: Georgia"><input type="range" style="font-family: Georgia"><input type="color" style="font-family: Georgia"><input type="hidden" value="x" style="font-family: Georgia">', rule: "font-families" },
  { name: "a focusable control in the stacks", body: '<button id="go">go</button><input value="typed">', rule: "font-families" },
  { name: "a canvas given a token family", body: `<canvas id="c"></canvas><script>document.getElementById("c").getContext("2d").font = ${JSON.stringify(canvasFont("--face-mono"))}</script>`, rule: "font-families" },
  { name: "the exact policy, spaced differently", head: cspMeta(CONTENT_SECURITY_POLICY.replace("; ", " ;  ")), rule: "csp-meta", only: ["csp-meta"] },
];

/** Builds the fixture site, judges every page as the cockpit is judged (every rule), and returns what failed. */
async function prove(executable: string | null): Promise<readonly string[]> {
  const dir = mkdtempSync(join(tmpdir(), "rendered-proof-"));
  const failures: string[] = [];
  try {
    writeFileSync(join(dir, "clean.html"), CLEAN);
    const page = (plant: Plant): string => CLEAN.replace("<!--PLANT-HEAD-->", plant.head ?? "").replace("<!--PLANT-BODY-->", plant.body ?? "");
    PLANTS.forEach((plant, i) => writeFileSync(join(dir, `plant-${i}.html`), page(plant)));
    CLEAN_TOO.forEach((plant, i) => writeFileSync(join(dir, `clean-${i}.html`), page(plant)));
    const rows = (only: readonly string[] | undefined): readonly PageRule[] | undefined =>
      only === undefined ? undefined : RENDERED_RULES.filter((r): r is PageRule => r.kind === "page" && only.includes(r.id));
    const { server, origin } = await serveSite(dir, "/proof", { [STEADY_PATH]: steady, ...Object.fromEntries(FACES.flatMap((face) => face.files).map((file) => [file, servedFont(file)])) });
    const browser = await launchBrowser(executable);
    try {
      // Every page is judged as the site is: every row (as on the cockpit) in every site render state, once ready,
      // then through its future; the request rows listen for the whole visit.
      const states = RENDER_STATES.filter((s) => s.surfaces.includes("site"));
      const judge = async (file: string, only?: readonly string[]): Promise<readonly string[]> => {
        const context = await browser.newContext({ serviceWorkers: "block" });
        const requests: string[] = [];
        await instrumentContext(context, "cockpit", origin, (finding) => requests.push(finding));
        const view = await openPage(context);
        await navigate(view, `${origin}/proof/${file}`);
        const selected = rows(only);
        const findings = [...(await judgeStates(view, "cockpit", siteRestore(), selected, states)), ...(await judgeFuture(view, "cockpit", selected)), ...(selected === undefined ? requests : [])];
        await context.close();
        return findings;
      };
      const clean = await judge("clean.html");
      if (clean.length > 0) failures.push(`the clean page is not clean:\n    ${clean.join("\n    ")}`);
      for (const [i, plant] of PLANTS.entries()) {
        const findings = await judge(`plant-${i}.html`, plant.only);
        if (!findings.some((f) => f.includes(`[${plant.rule}]`))) failures.push(`${plant.name}: not caught by ${plant.rule} (found: ${findings.join("; ") || "nothing"})`);
      }
      for (const [i, plant] of CLEAN_TOO.entries()) {
        const findings = await judge(`clean-${i}.html`, plant.only);
        if (findings.length > 0) failures.push(`the clean page is not clean (${plant.name}): ${findings.join("; ")}`);
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
  bootstrapProcess({ role: "cli" });
  const { values } = parseArgs({ args: process.argv.slice(2), options: { browser: { type: "string" } } });
  prove(values.browser ?? null).then((failures) => {
    for (const failure of failures) process.stdout.write(`${failure}\n`);
    process.stdout.write(`${JSON.stringify({ plants: PLANTS.length, caught: PLANTS.length - failures.filter((f) => !f.startsWith("the clean page")).length, cleanPagePasses: !failures.some((f) => f.startsWith("the clean page")), limits: JUDGE_LIMITS })}\n`);
    process.exitCode = failures.length === 0 ? 0 : 1;
  }, (error: unknown) => {
    process.stderr.write(`[rendered] REFUSED ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
