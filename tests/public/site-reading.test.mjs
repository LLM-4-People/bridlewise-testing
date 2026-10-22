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

/** The offset of each needle in `text`, each found, in the order given (an absent needle fails, never reads as -1). */
function inOrder(text, needles, message) {
  let from = 0;
  for (const needle of needles) {
    const at = text.indexOf(needle, from);
    assert.ok(at >= 0, `${message}: ${JSON.stringify(needle)} is missing, or comes before ${JSON.stringify(needles[needles.indexOf(needle) - 1] ?? "the start")}`);
    from = at + needle.length;
  }
}

/** The text between `start` and the first `end` after it; both must be there. */
function between(text, start, end) {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `${JSON.stringify(start)} is in the text`);
  const to = text.indexOf(end, from);
  assert.ok(to > from, `${JSON.stringify(end)} follows ${JSON.stringify(start)}`);
  return text.slice(from, to);
}

test("a reading page wraps its content in the docs navigation, the page and its sections", () => {
  const layout = read("docs/_layouts/default.html");
  const reading = between(layout, '<div class="reading">', "{% else %}");
  inOrder(reading, ["{% include docs-nav.html %}", '<article class="doc">'], "the docs navigation comes first");
  inOrder(reading, ["{% include record-head.html %}", "{{ content }}"], "a record's header precedes its text");
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
  const markup = between(toc, "<nav", "</nav>").replace(/\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/gu, "");
  assert.match(markup, /class="page-toc-title"/u);
  assert.doesNotMatch(markup, /<h[1-6]/u, "the list's own title is not a heading: the page keeps one outline");
});
