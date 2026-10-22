// The landing and the claims page are templates over the judged register
// (site.data.brand, written by the site build): no claim, count or promise is
// typed in them, every value they print is escaped, and the refusal they quote
// is the code's own sentence.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildAtlas } from "../../scripts/floor/atlas.mjs";
import { buildStatus } from "../../scripts/floor/status.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const TEMPLATES = ["docs/index.md", "docs/floor/claims.md", "docs/_includes/claims-ledger.html", "docs/_includes/claims-receipt.html", "docs/social/card.html"];
const claims = JSON.parse(read("docs/brand/claims.json")).claims;
const messaging = JSON.parse(read("docs/brand/messaging.json"));

/** Every `{{ … }}` output in a template whose value is not escaped, made a URL, or a count. */
export function unescapedOutputs(template) {
  return [...template.matchAll(/\{\{([^}]*)\}\}/gu)].map((match) => match[1].trim()).filter((expression) => {
    if (/\|\s*(?:escape|relative_url|absolute_url)\s*$/u.test(expression)) return false;
    if (/^brand\.counts(?:\.[\w-]+|\["[\w-]+"\])$/u.test(expression)) return false;
    if (/^brand\.commit \| slice: 0, 8$/u.test(expression) || /^include\.id$/u.test(expression) || /^site\.repository_url$/u.test(expression) || /^site\.lang \| default: 'en'$/u.test(expression)) return false;
    // A computed count, and a time printed through the date filter, carry no markup.
    if (/^total$/u.test(expression) || /\| date: "[%\w-]+"$/u.test(expression)) return false;
    return true;
  });
}

test("the templates print only escaped values from the register, the words, and the site's own coordinates", () => {
  for (const path of TEMPLATES) assert.deepEqual(unescapedOutputs(read(path)), [], path);
  assert.deepEqual(unescapedOutputs("{{ claim.text }} {{ words.promise | escape }} {{ brand.counts.holds }} {{ claim.proof.href | strip }}"), ["claim.text", "claim.proof.href | strip"], "the guard names an unescaped value");
});

test("no claim, promise or summary is typed in a template", () => {
  const typed = [...claims.map((claim) => claim.text), messaging.promise, messaging.summary, messaging.about.definition, messaging.about.line];
  for (const path of TEMPLATES) {
    const template = read(path);
    for (const words of typed) assert.ok(!template.includes(words), `${path} types "${words}"`);
  }
  const landing = read("docs/index.md");
  assert.match(landing, /site\.data\.brand/u);
  assert.match(landing, /\{% include claims-ledger\.html claims=brand\.claims %\}/u);
  assert.match(read("docs/floor/claims.md"), /\{% include claims-ledger\.html claims=brand\.claims %\}/u, "one ledger for both pages");
});

test("the refusal the landing shows is quoted from its source, verbatim", () => {
  const shown = claims.filter((claim) => claim.example !== undefined);
  assert.ok(shown.length >= 1, "a claim carries an example");
  for (const { example } of shown) {
    const source = read(example.source);
    assert.ok(source.includes(example.code) && source.includes(example.message), `${example.source} holds the quote`);
  }
});

test("the site writes the judged register for the templates, and no second claims page exists", () => {
  const design = read("scripts/floor/site-design.mjs");
  assert.match(design, /siteData\(root, /u);
  assert.match(design, /BRAND_DATA = "_data\/brand\.json"/u);
  const render = read("engine/scripts/brand/render.ts");
  assert.doesNotMatch(render, /claimsPage|claimsSitePage|<table|class="/u, "the claims have one markup: the templates");
  assert.doesNotMatch(read(".github/workflows/pages.yml"), /brand\/cli\.ts build/u, "the site build judges the claims; no second step does");
});

test("every check a claim binds is one the floor status reports, so a claim can hold at all", async () => {
  const status = await buildStatus({ root: ROOT, offline: true, counts: buildAtlas({ root: ROOT }).counts });
  const reported = new Set(status.checks.map((check) => check.id));
  assert.ok(reported.size >= 4, `the status reports its checks: ${[...reported].join(", ")}`);
  const unknown = claims.filter((claim) => claim.kind === "holds-when-green").flatMap((claim) => claim.checks.filter((id) => !reported.has(id)).map((id) => `${claim.id}: ${id}`));
  assert.deepEqual(unknown, [], "a claim bound to a check the status never reports is retracted forever");
});
