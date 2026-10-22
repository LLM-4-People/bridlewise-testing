// The public site wears the one design system (src/cockpit/tokens.css) and
// declares none of its own: every stylesheet the site build hands Jekyll is
// parsed and judged by scripts/floor/site-style.mjs (the build refuses a
// finding), and the text it sets meets WCAG 2.2 AA in both themes. Each arm
// is proved with planted violations and with near-misses that must pass.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { SHARED_CSS } from "../../scripts/floor/design-coverage.mjs";
import { buildSiteSource } from "../../scripts/floor/site.mjs";
import { markInclude } from "../../scripts/floor/site-design.mjs";
import { sitePlan } from "../../scripts/floor/site-pages.mjs";
import { declaredTokens, judgeSiteStyles, siteStyleViolations, STYLE_BURN_DOWN } from "../../scripts/floor/site-style.mjs";
import { BRAND_MARK } from "../../src/cockpit/shell/brand-mark.ts";
import { readNames, readTokenOwner, themeColor, THEMES, tokenSheet } from "../../shared/token-reader.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const OWNER = readTokenOwner(read("src/cockpit/tokens.css"));
const TOKENS = declaredTokens(OWNER);
const HEX = /#[0-9a-fA-F]{3,8}\b/u;
const judge = (css) => siteStyleViolations(css, { tokens: TOKENS });

/** A scratch directory under the run's TMPDIR, removed afterwards. */
function scratch(run) {
  const directory = mkdtempSync(join(tmpdir(), "site-style-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the site build judges every stylesheet it hands Jekyll, and they read only the owner's tokens", async () => {
  const directory = mkdtempSync(join(tmpdir(), "site-style-build-"));
  try {
    const out = join(directory, "site");
    // The floor data is not a stylesheet: an empty snapshot keeps the build offline and fast.
    await buildSiteSource({ root: ROOT, out, baseurl: "/site", floorData: async () => ({ atlas: {}, status: {} }) });
    const { sheets, findings } = judgeSiteStyles({ root: ROOT, sourceRoot: out });
    assert.deepEqual(findings, []);
    for (const path of ["assets/css/style.css", "assets/floor/floor.css", ...STYLE_BURN_DOWN.keys()]) assert.ok(sheets.includes(path), `the build input lists ${path}`);
    assert.ok(!sheets.includes("assets/css/tokens.css"), "the generated token sheet is the owner's projection, judged by its generator");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the guard parses: each violation is found in any case, in a rule and in a media block", () => {
  const planted = [
    [".a { color: #101216; }", /colour literal: #101216/u],
    [".a { color: #FFF; }", /colour literal: #FFF/u],
    ["@media (max-width: 960px) { .b { background: rgba(0, 0, 0, 0.5); } }", /colour literal: rgba\(\)/u],
    [".b { background: RGB(0, 0, 0); }", /colour literal: RGB\(\)/u],
    [".c { border-color: oklch(0.7 0.1 250); }", /colour literal: oklch\(\)/u],
    [".c { color: red; }", /colour literal: red/u],
    [".c { border: 1px solid Tomato; }", /colour literal: Tomato/u],
    [".c { outline-color: CanvasText; }", /colour literal: CanvasText/u],
    [".c { color: var(--ink-1, #fff); }", /carries a fallback/u],
    [".c { color: var(--site-only); }", /declares no such token/u],
    [".d { --local: 4px; }", /custom property declared/u],
    [":root { color: var(--ink-1); }", /theme block/u],
    ['html[data-theme="carbon"] .e { color: var(--ink-1); }', /theme block/u],
    [".f { transition: opacity 120ms ease; }", /duration literal: 120ms/u],
    [".f { transition: opacity 120MS ease; }", /duration literal: 120MS/u],
    [".g { animation: spin .2s linear; }", /duration literal: \.2s/u],
    [".h { color: var(--ink-3); }", /faint ink as text/u],
    [".i { font-family: Georgia, serif; }", /not one --face-\* token/u],
    [".i { font: 16px/1.5 Georgia; }", /the shorthand sets a family/u],
    ['@import url("https://fonts.example/plex.css");', /@import: a sheet is linked by the layout/u],
    ['@import "local.css";', /@import: a sheet is linked by the layout/u],
    [".j { background: url(https://cdn.example/x.png); }", /url\(\) leaves the site/u],
    [".j { background: url(//cdn.example/x.png); }", /url\(\) leaves the site/u],
    ["@font-face { font-family: Plex; src: url(/x.woff2); }", /@font-face/u],
    ["@property --x { syntax: '<number>'; inherits: false; initial-value: 0; }", /@property/u],
    ["@page { margin: 0; }", /not an at-rule/u],
    [".k { color: var(--ink-1);", /never closed/u],
  ];
  for (const [css, expected] of planted) {
    const findings = judge(css);
    assert.ok(findings.some((finding) => expected.test(finding)), `planted: ${css} gave ${JSON.stringify(findings)}`);
  }
  const nearMisses = [
    ".a { color: var(--ink-1); background: color-mix(in srgb, var(--accent) 12%, transparent); }",
    ".a { color: currentColor; text-decoration-color: currentcolor; }",
    ".b { transition: background var(--t-1) var(--ease-out), color var(--t-1); }",
    "#main .c { width: calc(100% - var(--sp-6)); }",
    ".d { border: var(--hairline-w) solid var(--line-1); }",
    ".e { border-bottom-color: var(--ink-3); }",
    "@media (max-width: 960px) { .f { display: none; } }",
    ".g { content: \"#1 red 120ms {\"; grid-template-columns: repeat(2, 1fr); }",
    ".h { font-family: var(--face-mono); }",
    ".h { font: inherit; }",
    ".i { background: url(../img/local.png); }",
  ];
  for (const css of nearMisses) assert.deepEqual(judge(css), [], `near-miss: ${css}`);
});

test("the file set is the build input: a Sass source anywhere is refused; the token sheet is the generator's", () => {
  scratch((source) => {
    const put = (path, text) => {
      mkdirSync(dirname(join(source, path)), { recursive: true });
      writeFileSync(join(source, path), text);
    };
    put("assets/css/style.css", ".a { color: var(--ink-1); }\n");
    put("assets/css/main.scss", "---\n---\n$ink: #101216;\n.a { color: $ink; }\n");
    put("_sass/partial.scss", ".b { color: red; }\n");
    put("assets/css/tokens.css", ":root { --ink-1: #101216; }\n");
    const { sheets, findings } = judgeSiteStyles({ root: ROOT, sourceRoot: source });
    assert.ok(!sheets.includes("assets/css/tokens.css"), "the generated token sheet is not judged here");
    assert.deepEqual(findings.map((finding) => finding.split(":")[0]), ["_sass/partial.scss", "assets/css/main.scss"]);
    assert.ok(findings.every((finding) => /a Sass source/u.test(finding)));
  });
});

test("the burn-down list only shrinks: each entry is still in the source and still fails", () => {
  for (const [path, issue] of STYLE_BURN_DOWN) {
    assert.ok(existsSync(join(ROOT, "docs", path)), `${path} is gone: delete its burn-down entry (${issue})`);
    assert.ok(judge(read(`docs/${path}`)).length > 0, `${path} is clean now: delete its burn-down entry (${issue})`);
  }
});

test("the shell's stylesheets compile into a token sheet: every name they read is the owner's", () => {
  const used = new Set(SHARED_CSS.flatMap((path) => [...readNames(read(`docs/${path}`))]));
  assert.ok(used.has("--ground-0") && used.has("--page-measure"), "the shell reads the ground and the public page's measure");
  const sheet = tokenSheet(OWNER, used, { themeAttribute: "data-theme", lead: "logbook", fontUrl: (url) => url, banner: "test" });
  assert.match(sheet, /:root \{\n {2}color-scheme: light;/u, "Logbook (paper) leads");
  assert.match(sheet, /:root\[data-theme="carbon"\] \{\n {2}color-scheme: dark;/u, "Carbon is available");
  assert.throws(() => tokenSheet(OWNER, [...used, "--site-only-colour"], { themeAttribute: "data-theme", lead: "logbook", fontUrl: (url) => url, banner: "test" }), /token_undeclared/u);
});

/** WCAG 2.2 relative luminance contrast of two `#rrggbb` colours. */
function contrast(foreground, background) {
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255).map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/** Every ink the site sets text in, and every ground it sets text on. */
const TEXT_INKS = ["--ink-1", "--ink-2", "--accent", "--ok", "--warn", "--alarm", "--syn-string", "--syn-number", "--syn-keyword", "--syn-type", "--syn-func", "--syn-punct", "--syn-meta"];
const TEXT_GROUNDS = ["--ground-0", "--ground-1", "--ground-2"];

test("text meets WCAG 2.2 AA (4.5:1) on every ground, in both themes; a control's edge meets 3:1", () => {
  const failures = [];
  assert.deepEqual([...THEMES], ["logbook", "carbon"], "Logbook leads");
  for (const theme of THEMES) {
    for (const ground of TEXT_GROUNDS) {
      const background = themeColor(OWNER, theme, ground);
      for (const ink of TEXT_INKS) {
        const ratio = contrast(themeColor(OWNER, theme, ink), background);
        if (ratio < 4.5) failures.push(`${theme}: ${ink} on ${ground} is ${ratio.toFixed(2)}:1`);
      }
      const edge = contrast(themeColor(OWNER, theme, "--ink-2"), background);
      if (edge < 3) failures.push(`${theme}: a control edge (--ink-2) on ${ground} is ${edge.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(contrast("#757c86", "#f6f4ef") < 4.5, "the arm can fail: Logbook's --ink-3 on its ground is below AA");
});

test("the layout draws no mark and holds no colour: the mark comes from its one geometry", () => {
  const layout = read("docs/_layouts/default.html");
  assert.doesNotMatch(layout, /<svg/u, "the layout includes the generated mark");
  assert.doesNotMatch(layout.replace(/\{\{[\s\S]*?\}\}/gu, ""), HEX, "no colour literal in the layout");
  assert.match(layout, /\{% include brand-mark\.svg %\}/u);
  assert.match(layout, /\{% include design-head\.html %\}/u);
  const mark = markInclude();
  assert.equal((mark.match(/<path /gu) ?? []).length, 1 + BRAND_MARK.lines.length);
  assert.match(mark, new RegExp(`cx="${BRAND_MARK.beam.at[0]}" cy="${BRAND_MARK.beam.at[1]}" r="${BRAND_MARK.beam.r}"`, "u"));
  assert.doesNotMatch(mark, HEX, "the mark is inked by the stylesheet, from the live theme");
  for (const retired of ["docs/assets/logo.svg", "docs/assets/wordmark.svg"]) assert.equal(existsSync(join(ROOT, retired)), false, `${retired} is a retired mark`);
  assert.match(layout, /href="\{\{ '\/assets\/mark\.svg' \| relative_url \}\}"/u, "the favicon is the generated mark (scripts/generate-pwa-icons.mjs)");
});

test("every navigation entry names a page the site publishes", () => {
  const navigation = parse(read("docs/_data/navigation.yml"));
  const plan = sitePlan({ root: ROOT });
  const paths = [...navigation.primary, ...navigation.sections.flatMap((section) => section.links)].map((entry) => entry.path);
  assert.ok(paths.length >= 20, "the navigation lists the site");
  const missing = paths.filter((path) => !plan.byPermalink.has(path)
    && !existsSync(join(ROOT, "docs", path, "index.html"))
    && !existsSync(join(ROOT, "docs", path)));
  assert.deepEqual(missing, []);
  const layout = read("docs/_layouts/default.html");
  assert.match(layout, /site\.data\.navigation\.primary/u);
  assert.match(layout, /site\.data\.navigation\.sections/u);
  assert.doesNotMatch(layout, /href="\{\{ '\/(?:quickstart|architecture|cli|faq|decisions)\/'/u, "no hand-kept navigation link in the layout");
});
