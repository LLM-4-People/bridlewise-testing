// The reading page: every documentation page carries the docs navigation,
// its own sections ("On this page") and, for a decision record, a header read
// from the record's front matter. The vocabularies come from their owners.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DECISION_IMPLEMENTATIONS, DECISION_STATUSES } from "../../engine/scripts/verification/tracker-entries.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

test("a reading page wraps its content in the docs navigation, the page and its sections", () => {
  const layout = read("docs/_layouts/default.html");
  const reading = layout.slice(layout.indexOf('<div class="reading">'), layout.indexOf("{% else %}", layout.indexOf('<div class="reading">')));
  assert.ok(reading.indexOf("{% include docs-nav.html %}") < reading.indexOf('<article class="doc">'), "the docs navigation comes first");
  assert.ok(reading.indexOf("{% include record-head.html %}") < reading.indexOf("{{ content }}"), "a record's header precedes its text");
  assert.match(reading, /\{% include page-toc\.html content=content %\}/u);
  assert.match(read("docs/_includes/docs-nav.html"), /site\.data\.navigation\.sections/u, "the docs navigation is the one navigation source");
  assert.match(layout, /\{%- capture page_title -%\}\{% if page\.title %\}/u, "a page without a title is named by its first heading");
});

test("the record header names every implementation state the decision format allows, and every status", () => {
  const head = read("docs/_includes/record-head.html");
  const named = [...head.matchAll(/\{%- when "([a-z-]+)" -%\}/gu)].map((match) => match[1]);
  assert.deepEqual([...named].sort(), [...DECISION_IMPLEMENTATIONS].sort());
  const css = read("docs/assets/css/style.css");
  for (const state of [...DECISION_IMPLEMENTATIONS, ...DECISION_STATUSES]) {
    assert.match(css, new RegExp(`\\.state\\[data-state="${state}"\\]`, "u"), `${state} has its state ink`);
  }
});

test("the on-this-page list reads the rendered second-level headings and appears only for a page with sections", () => {
  const toc = read("docs/_includes/page-toc.html");
  assert.match(toc, /include\.content \| split: '<h2 id="'/u);
  assert.match(toc, /toc_parts\.size > 3/u, "three sections or more");
  const markup = toc.slice(toc.indexOf("<nav"), toc.indexOf("</nav>")).replace(/\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/gu, "");
  assert.match(markup, /class="page-toc-title"/u);
  assert.doesNotMatch(markup, /<h[1-6]/u, "the list's own title is not a heading: the page keeps one outline");
});
