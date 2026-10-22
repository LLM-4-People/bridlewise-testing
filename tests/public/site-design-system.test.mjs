// The public site wears the one design system (src/cockpit/tokens.css) and
// declares none of its own: every stylesheet under docs/ reads the owner's
// tokens through the generated sheet, and the text it sets meets WCAG 2.2 AA
// in both themes. Each arm is proved with planted violations in more than one
// place and with near-misses that must pass.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { SHARED_CSS } from "../../scripts/floor/design-coverage.mjs";
import { markInclude } from "../../scripts/floor/site-design.mjs";
import { sitePlan } from "../../scripts/floor/site-pages.mjs";
import { BRAND_MARK } from "../../src/cockpit/shell/brand-mark.ts";
import { walk } from "../../engine/scripts/verification/source-walk.ts";
import { readNames, readTokenOwner, themeColor, THEMES, tokenSheet } from "../../shared/token-reader.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const OWNER = readTokenOwner(read("src/cockpit/tokens.css"));

/**
 * The burn-down list: stylesheets that still carry a palette of their own.
 * It only shrinks; each entry names the issue that removes it.
 */
const BURN_DOWN = new Map([
  ["docs/run/run-demo.css", "#161: the run demo's own palette"],
  ["docs/policy-lab/policy-lab.css", "#161: the policy lab's own palette"],
]);

/** The site's files of one kind, through the one source walk (repository-relative). */
const files = (directory, extension) => walk(join(ROOT, directory), { exts: [extension] }).map((path) => relative(ROOT, path).split(sep).join("/"));

const COLOUR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/u;
const HEX = /#[0-9a-fA-F]{3,8}\b/u;
const DURATION = /(?<![\w-])\d*\.?\d+m?s\b/u;

/** What a site stylesheet may not hold (see the header). */
export function siteStyleViolations(css) {
  const findings = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  for (const block of text.matchAll(/([^{}]*)\{([^{}]*)\}/gu)) {
    const selector = block[1].trim();
    if (/:root\b|\[data-theme\b|\[data-cockpit-theme\b/u.test(selector)) findings.push(`theme block: ${selector}`);
    for (const declaration of block[2].split(";")) {
      const match = /^\s*([\w-]+)\s*:\s*([\s\S]+?)\s*$/u.exec(declaration);
      if (match === null) continue;
      const [, property, value] = match;
      const literal = value.replace(/var\([^()]*\)/gu, "");
      if (property.startsWith("--")) findings.push(`custom property declared: ${property}`);
      if (HEX.test(literal) || COLOUR_FUNCTION.test(literal.replace(/color-mix\(/gu, ""))) findings.push(`colour literal: ${property}: ${value}`);
      if (/^(?:transition|animation)(?:-duration|-delay)?$/u.test(property) && DURATION.test(literal)) findings.push(`duration literal: ${property}: ${value}`);
      if (property === "color" && /var\(\s*--ink-[34]\s*\)/u.test(value)) findings.push(`faint ink as text: ${property}: ${value}`);
    }
  }
  return findings;
}

test("every stylesheet under docs/ uses only the owner's tokens (the burn-down list only shrinks)", () => {
  const sheets = files("docs", ".css");
  assert.ok(sheets.length >= 4, `the walk found the site's stylesheets: ${sheets.join(", ")}`);
  for (const path of BURN_DOWN.keys()) assert.ok(sheets.includes(path), `${path} is gone: delete its burn-down entry`);
  const offenders = [];
  for (const path of sheets) {
    const findings = siteStyleViolations(read(path));
    if (BURN_DOWN.has(path)) {
      assert.ok(findings.length > 0, `${path} is clean now: delete its burn-down entry (${BURN_DOWN.get(path)})`);
      continue;
    }
    offenders.push(...findings.map((finding) => `${path}: ${finding}`));
  }
  assert.deepEqual(offenders, []);
});

test("the guard catches each violation, in a rule and in a media block, and passes the near-misses", () => {
  const planted = [
    ".a { color: #101216; }",
    "@media (max-width: 960px) { .b { background: rgba(0, 0, 0, 0.5); } }",
    ".c { border-color: oklch(0.7 0.1 250); }",
    ".d { --local: 4px; }",
    ":root { color: var(--ink-1); }",
    'html[data-theme="carbon"] .e { color: var(--ink-1); }',
    ".f { transition: opacity 120ms ease; }",
    ".g { animation-duration: .2s; }",
    ".h { color: var(--ink-3); }",
  ];
  for (const css of planted) assert.equal(siteStyleViolations(css).length, 1, `planted: ${css}`);
  const nearMisses = [
    ".a { color: var(--ink-1); background: color-mix(in srgb, var(--accent) 12%, transparent); }",
    ".b { transition: opacity var(--t-1) var(--ease-out); }",
    "#main .c { width: calc(100% - var(--sp-6)); }",
    ".d { border: var(--hairline-w) solid var(--line-1); }",
    ".e { border-bottom-color: var(--ink-3); }",
    "@media (max-width: 960px) { .f { display: none; } }",
    ".g { content: \"#1\"; grid-template-columns: repeat(2, 1fr); }",
  ];
  for (const css of nearMisses) assert.deepEqual(siteStyleViolations(css), [], `near-miss: ${css}`);
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
